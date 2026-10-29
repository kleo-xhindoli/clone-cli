/**
 * Streaming delete pipeline.
 *
 * Listing can take minutes on big calendars, so the producer (listClones) and
 * the consumer (delete workers) run concurrently: as soon as the first page
 * of clones arrives, deletion starts while the remaining pages are still read.
 *
 * Lessons from real runs are built in:
 *  - An exception instance of a recurring clone (id "master_20261029T100000Z")
 *    is deleted together with its master, so it is skipped when the master is
 *    also a clone. It is only deleted on its own if the master never shows up
 *    as a clone, or if deleting the master fails for good.
 *  - Google answers 409 Conflict for every part of a batch sent while it is
 *    still cascading the previous batch's series deletes. 409 is retried after
 *    a delay, and the pipeline pauses after any batch that deleted a recurring
 *    master, and longer after any conflict.
 *  - A 401 means the access token expired. Work pauses, the caller is asked
 *    for a new token, and the affected items are re-queued without counting
 *    as an attempt. If no token is given the run stops and reports what was
 *    left.
 */
import type { CloneEvent, CloneProvider, DeleteResult, ListProgressInfo } from "../providers/types.js";

export type DeleteMode = "batch" | "single";

export interface PipelineCounts {
  found: number;
  deleted: number;
  alreadyGone: number;
  failed: number;
  pending: number;
  retried: number;
  /** Exception instances not requested because their series master is a clone. */
  skippedCovered: number;
  /** Left in the calendar because the run stopped (no fresh token). */
  notAttempted: number;
}

export type PauseReason = "series" | "conflict";

export interface PipelineEvents {
  onListPage?: (info: ListProgressInfo) => void;
  onListDone?: (info: { totalClones: number }) => void;
  onListError?: (err: unknown) => void;
  /** Listing is started over after a token refresh; pages already seen are deduplicated. */
  onListRestart?: () => void;
  onBatchStart?: (info: { size: number; batchNumber: number }) => void;
  onBatchDone?: (info: { size: number; batchNumber: number; results: DeleteResult[] }) => void;
  onResult?: (event: CloneEvent, result: DeleteResult, attempt: number) => void;
  onSkipped?: (event: CloneEvent, masterId: string) => void;
  onPause?: (info: { reason: PauseReason; ms: number }) => void;
  onRetryScheduled?: (event: CloneEvent, result: DeleteResult, attempt: number, delayMs: number) => void;
  /**
   * Called once when a 401 is seen. Resolve true after the provider's
   * credentials were updated (work resumes), false to stop the run.
   */
  onAuthExpired?: () => Promise<boolean>;
  onCounts?: (counts: PipelineCounts) => void;
}

export interface PipelineOptions {
  provider: CloneProvider;
  calendarId: string;
  mode: DeleteMode;
  /** Concurrent delete workers. Only >1 for providers without a batch API (CalDAV). */
  concurrency?: number;
  maxAttempts?: number;
  /** Delay before a retriable failure is attempted again. */
  retryDelayMs?: (attempt: number, result: DeleteResult) => number;
  /** Pause after a batch that contained a recurring series master. */
  paceAfterSeriesMs?: number;
  /** Pause after a batch in which any part answered 409. */
  conflictBackoffMs?: number;
  events?: PipelineEvents;
}

export interface PipelineSummary {
  counts: PipelineCounts;
  listingComplete: boolean;
  listingError?: unknown;
  /** Set when the run stopped early (for example no fresh token was given). */
  stoppedReason?: string;
  failures: Array<{ event: CloneEvent; result: DeleteResult }>;
  /** Only ids and outcomes are kept, so a run over thousands of clones stays small. */
  results: Array<{ id: string; status: DeleteResult["status"] }>;
}

interface QueueItem {
  event: CloneEvent;
  attempt: number;
  notBefore: number;
}

const DEFAULT_PACE_AFTER_SERIES_MS = 3_000;
const DEFAULT_CONFLICT_BACKOFF_MS = 10_000;
const defaultRetryDelay = (attempt: number) => 5_000 * attempt;

export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return status === 401;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runDeletePipeline(options: PipelineOptions): Promise<PipelineSummary> {
  const { provider, calendarId, mode } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const chunkSize = mode === "batch" ? provider.batchSize : 1;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
  const paceAfterSeriesMs = options.paceAfterSeriesMs ?? DEFAULT_PACE_AFTER_SERIES_MS;
  const conflictBackoffMs = options.conflictBackoffMs ?? DEFAULT_CONFLICT_BACKOFF_MS;
  const events = options.events ?? {};

  const queue: QueueItem[] = [];
  const retryQueue: QueueItem[] = [];
  const counts: PipelineCounts = {
    found: 0,
    deleted: 0,
    alreadyGone: 0,
    failed: 0,
    pending: 0,
    retried: 0,
    skippedCovered: 0,
    notAttempted: 0,
  };
  const failures: PipelineSummary["failures"] = [];
  const results: PipelineSummary["results"] = [];
  let listingDone = false;
  let listingError: unknown;
  let stoppedReason: string | undefined;
  let batchNumber = 0;
  let inFlight = 0;
  let pausedUntil = 0;
  let authGate: Promise<boolean> | null = null;

  // Series bookkeeping (change 1).
  const knownClones = new Set<string>();
  /** masterId -> instances waiting to learn whether their master is a clone. */
  const deferred = new Map<string, QueueItem[]>();
  /** masterId -> instances skipped because the master is a clone; needed if the master fails. */
  const covered = new Map<string, CloneEvent[]>();

  // Wakes idle workers when the queue changes or listing finishes.
  let wake: () => void = () => {};
  let wakePromise = new Promise<void>((resolve) => (wake = resolve));
  const notify = () => {
    wake();
    wakePromise = new Promise<void>((resolve) => (wake = resolve));
  };
  const emitCounts = () => events.onCounts?.({ ...counts });

  const enqueue = (event: CloneEvent, attempt = 1) => {
    queue.push({ event, attempt, notBefore: 0 });
    counts.pending++;
  };

  const skip = (event: CloneEvent, masterId: string) => {
    counts.skippedCovered++;
    const list = covered.get(masterId) ?? [];
    list.push(event);
    covered.set(masterId, list);
    events.onSkipped?.(event, masterId);
  };

  const route = (event: CloneEvent) => {
    counts.found++;
    knownClones.add(event.id);
    const masterId = event.recurringEventId;
    if (masterId) {
      if (knownClones.has(masterId)) {
        skip(event, masterId);
      } else {
        const list = deferred.get(masterId) ?? [];
        list.push({ event, attempt: 1, notBefore: 0 });
        deferred.set(masterId, list);
      }
      return;
    }
    const waiting = deferred.get(event.id);
    if (waiting) {
      deferred.delete(event.id);
      for (const item of waiting) skip(item.event, event.id);
    }
    enqueue(event);
  };

  /** Instances whose master never turned out to be a clone are deleted on their own. */
  const flushDeferred = () => {
    for (const items of deferred.values()) {
      for (const item of items) enqueue(item.event);
    }
    deferred.clear();
  };

  const handleAuthExpired = async (): Promise<boolean> => {
    if (!authGate) {
      authGate = (async () => {
        const ok = events.onAuthExpired ? await events.onAuthExpired() : false;
        if (!ok) stoppedReason ??= "access token expired and no new token was given";
        return ok;
      })();
      const ok = await authGate;
      authGate = null;
      notify();
      return ok;
    }
    return authGate;
  };

  const producer = (async () => {
    const seen = new Set<string>();
    for (;;) {
      try {
        for await (const page of provider.listClones(calendarId, (info) => events.onListPage?.(info))) {
          if (stoppedReason) break;
          for (const event of page) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            route(event);
          }
          emitCounts();
          notify();
        }
        if (!stoppedReason) events.onListDone?.({ totalClones: counts.found });
        else listingError = new Error(stoppedReason);
        break;
      } catch (err) {
        if (isAuthError(err) && (await handleAuthExpired())) {
          events.onListRestart?.();
          continue;
        }
        listingError = err;
        events.onListError?.(err);
        break;
      }
    }
    listingDone = true;
    flushDeferred();
    emitCounts();
    notify();
  })();

  const record = (item: QueueItem, result: DeleteResult) => {
    events.onResult?.(item.event, result, item.attempt);
    const canRetry = result.status === "failed" && result.retriable && item.attempt < maxAttempts;
    if (canRetry) {
      counts.retried++;
      const delay = retryDelayMs(item.attempt, result);
      retryQueue.push({ event: item.event, attempt: item.attempt + 1, notBefore: Date.now() + delay });
      events.onRetryScheduled?.(item.event, result, item.attempt, delay);
      return;
    }
    counts.pending--;
    results.push({ id: item.event.id, status: result.status });
    if (result.status === "deleted") counts.deleted++;
    else if (result.status === "already_gone") counts.alreadyGone++;
    else {
      counts.failed++;
      failures.push({ event: item.event, result });
      // The series still exists, so its exceptions must be deleted one by one.
      const instances = covered.get(item.event.id);
      if (instances) {
        covered.delete(item.event.id);
        for (const event of instances) {
          counts.skippedCovered--;
          enqueue(event);
        }
      }
    }
  };

  const takeReady = (): QueueItem[] => {
    const now = Date.now();
    const items = queue.splice(0, chunkSize);
    if (items.length < chunkSize && retryQueue.length) {
      for (let i = 0; i < retryQueue.length && items.length < chunkSize; ) {
        if (retryQueue[i].notBefore <= now) items.push(...retryQueue.splice(i, 1));
        else i++;
      }
    }
    return items;
  };

  const nothingLeft = () => listingDone && !queue.length && !retryQueue.length && inFlight === 0;

  const worker = async () => {
    for (;;) {
      if (authGate) {
        if (!(await authGate)) return;
        continue;
      }
      if (stoppedReason) return;

      const now = Date.now();
      if (pausedUntil > now) {
        await sleep(Math.min(pausedUntil - now, 1_000));
        continue;
      }

      const items = takeReady();
      if (!items.length) {
        if (nothingLeft()) return;
        const nextRetry = retryQueue.length ? Math.min(...retryQueue.map((i) => i.notBefore)) - now : Infinity;
        await Promise.race([wakePromise, sleep(Math.max(50, Math.min(nextRetry, 1_000)))]);
        continue;
      }

      inFlight += items.length;
      const number = ++batchNumber;
      events.onBatchStart?.({ size: items.length, batchNumber: number });

      let batchResults: DeleteResult[];
      if (mode === "batch" && provider.batchSize > 1) {
        batchResults = await provider.batchDeleteClones(calendarId, items.map((i) => i.event));
      } else {
        batchResults = [await provider.deleteClone(calendarId, items[0].event)];
      }
      inFlight -= items.length;

      // Change 4: a 401 pauses everything; the items go back untouched.
      if (batchResults.some((r) => r.statusCode === 401)) {
        for (const item of items) queue.unshift({ ...item });
        events.onBatchDone?.({ size: items.length, batchNumber: number, results: batchResults });
        const ok = await handleAuthExpired();
        if (!ok) return;
        continue;
      }

      items.forEach((item, index) => {
        const result =
          batchResults[index] ??
          ({ id: item.event.id, status: "failed", retriable: false, error: "Provider returned no result" } as DeleteResult);
        record(item, result);
      });
      events.onBatchDone?.({ size: items.length, batchNumber: number, results: batchResults });

      // Change 3: let the calendar settle after series deletes and after conflicts.
      if (batchResults.some((r) => r.statusCode === 409) && conflictBackoffMs > 0) {
        pausedUntil = Math.max(pausedUntil, Date.now() + conflictBackoffMs);
        events.onPause?.({ reason: "conflict", ms: conflictBackoffMs });
      } else if (items.some((i) => i.event.isRecurring) && paceAfterSeriesMs > 0) {
        pausedUntil = Math.max(pausedUntil, Date.now() + paceAfterSeriesMs);
        events.onPause?.({ reason: "series", ms: paceAfterSeriesMs });
      }

      emitCounts();
      notify();
    }
  };

  await Promise.all([producer, ...Array.from({ length: concurrency }, () => worker())]);

  if (stoppedReason) {
    counts.notAttempted = queue.length + retryQueue.length;
    counts.pending = 0;
  }

  return { counts, listingComplete: !listingError, listingError, stoppedReason, failures, results };
}

/** Collects every clone without deleting anything (the "list" operation). */
export async function collectClones(
  provider: CloneProvider,
  calendarId: string,
  onPage?: PipelineEvents["onListPage"]
): Promise<CloneEvent[]> {
  const all: CloneEvent[] = [];
  for await (const page of provider.listClones(calendarId, onPage)) {
    all.push(...page);
  }
  return all;
}
