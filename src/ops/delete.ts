import pc from "picocolors";
import { runDeletePipeline, type DeleteMode, type PipelineCounts, type PipelineSummary } from "../core/pipeline.js";
import type { FileLogger } from "../logging/file-logger.js";
import type { CalendarInfo, CloneProvider } from "../providers/types.js";
import { describeListingProgress, describePage, formatDuration, keyValueBlock, log, status, table, truncateText } from "../cli/ui.js";

const CALDAV_BATCH_CONCURRENCY = 5;
const MAX_FAILURES_SHOWN = 25;

export async function runDelete(options: {
  provider: CloneProvider;
  calendar: CalendarInfo;
  mode: DeleteMode;
  logger: FileLogger;
  /** Asks the user for a fresh credential after a 401; resolves false to stop. */
  onAuthExpired: () => Promise<boolean>;
}): Promise<PipelineSummary> {
  const { provider, calendar, mode, logger } = options;
  const startedAt = Date.now();
  const concurrency = provider.batchSize === 1 && mode === "batch" ? CALDAV_BATCH_CONCURRENCY : 1;

  log.step(`Deleting OneCal clones from ${pc.bold(calendar.name)} (${provider.label}, ${mode === "batch" ? "batch" : "non-batch"} mode)`);
  log.info("Listing and deleting run in parallel: deletion starts as soon as the first clones are found.");
  logger.info("op.delete.start", { provider: provider.name, calendarId: calendar.id, calendarName: calendar.name, mode, concurrency });

  let listingDone = false;
  let cancelledIgnored = 0;
  let listingText = "starting listing…";
  let latest: PipelineCounts = { found: 0, deleted: 0, alreadyGone: 0, failed: 0, pending: 0, retried: 0, skippedCovered: 0, notAttempted: 0 };
  let currentBatch = "";
  let pauseNote = "";
  let pauseTimer: NodeJS.Timeout | undefined;

  const refresh = () => {
    const listing = listingDone ? "listing done" : listingText;
    const parts = [
      `found ${latest.found}`,
      `deleted ${latest.deleted}`,
      latest.alreadyGone ? `already gone ${latest.alreadyGone}` : "",
      latest.failed ? pc.red(`failed ${latest.failed}`) : "",
      latest.skippedCovered ? `skipped ${latest.skippedCovered} (covered by series)` : "",
      `pending ${latest.pending}`,
    ].filter(Boolean);
    const tail = [currentBatch, pauseNote].filter(Boolean).join(" | ");
    status.set(`${listing} | ${parts.join(", ")}${tail ? ` | ${tail}` : ""}`);
  };

  status.set("Requesting first page of events…");

  const summary = await runDeletePipeline({
    provider,
    calendarId: calendar.id,
    mode,
    concurrency,
    events: {
      onListPage: (info) => {
        status.touch();
        listingText = describeListingProgress(info);
        if (info.totalCancelled) cancelledIgnored = info.totalCancelled;
        if (info.phase === "done") log.info(describePage(info));
        refresh();
      },
      onListDone: (info) => {
        listingDone = true;
        log.success(`Listing finished: ${info.totalClones} clone(s) found in total`);
        refresh();
      },
      onListRestart: () => {
        listingDone = false;
        log.info("Restarting the listing with the new credentials; clones already seen are skipped.");
        refresh();
      },
      onListError: (err) => {
        listingDone = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Listing stopped early: ${message}. Clones found so far will still be deleted.`);
        logger.error("op.delete.listing_error", { error: message });
        refresh();
      },
      onBatchStart: ({ size, batchNumber }) => {
        currentBatch = mode === "batch" && provider.batchSize > 1 ? `sending batch #${batchNumber} (${size} deletes)` : `deleting #${batchNumber}`;
        refresh();
      },
      onBatchDone: ({ size, batchNumber, results }) => {
        status.touch();
        currentBatch = "";
        if (mode === "batch" && provider.batchSize > 1) {
          const ok = results.filter((r) => r.status !== "failed").length;
          const failed = size - ok;
          const text = `Batch #${batchNumber}: ${ok}/${size} ok${failed ? `, ${failed} failed` : ""}`;
          failed ? log.warn(text) : log.info(text);
        }
      },
      onSkipped: (event, masterId) => {
        logger.info("op.delete.skipped", { eventId: event.id, title: event.title, masterId, reason: "covered by recurring series" });
      },
      onRetryScheduled: (event, result, attempt, delayMs) => {
        logger.warn("op.delete.retry_scheduled", { eventId: event.id, attempt, statusCode: result.statusCode, delayMs });
      },
      onPause: ({ reason, ms }) => {
        const seconds = Math.round(ms / 1000);
        pauseNote =
          reason === "conflict"
            ? pc.yellow(`backing off ${seconds}s after conflicts`)
            : pc.dim(`pausing ${seconds}s so the series deletes can settle`);
        if (reason === "conflict") {
          log.warn(`Google answered 409 Conflict; backing off ${seconds}s before the next batch. The affected clones will be retried.`);
        }
        logger.info("op.delete.pause", { reason, ms });
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(() => {
          pauseNote = "";
          refresh();
        }, ms);
        pauseTimer.unref();
        refresh();
      },
      onAuthExpired: async () => {
        status.clear();
        log.warn(`${provider.label} rejected the ${provider.credentialLabel} (401): it has probably expired. Work is paused; nothing was lost.`);
        logger.warn("op.delete.auth_expired", {});
        const ok = await options.onAuthExpired();
        logger.info("op.delete.auth_refreshed", { continued: ok });
        if (ok) {
          log.success("Credentials updated, resuming.");
          refresh();
        } else {
          log.error("No new credentials given; stopping. Run the tool again to delete the remaining clones.");
        }
        return ok;
      },
      onResult: (event, result, attempt) => {
        logger.info("op.delete.result", { eventId: event.id, title: event.title, attempt, ...result });
        if (result.status === "failed") {
          const retry = result.retriable && attempt < 3 ? " (will retry)" : "";
          // A whole batch of 409s is reported once by onPause instead of 50 times here.
          if (result.statusCode !== 409 || !retry) {
            log.warn(`Failed to delete ${event.id}${event.title ? ` "${truncateText(event.title, 30)}"` : ""}: ${result.error}${retry}`);
          }
        } else if (mode === "single" || provider.batchSize === 1) {
          const label = result.status === "already_gone" ? "already gone" : "deleted";
          log.info(`${label}: ${event.id}${event.title ? ` "${truncateText(event.title, 30)}"` : ""}`);
        }
      },
      onCounts: (counts) => {
        latest = counts;
        refresh();
      },
    },
  });

  clearTimeout(pauseTimer);
  status.clear();
  const durationMs = Date.now() - startedAt;
  logger.info("op.delete.done", { ...summary.counts, listingComplete: summary.listingComplete, durationMs });

  printSummary(summary, durationMs, logger.path, cancelledIgnored);
  return summary;
}

export function printSummary(summary: PipelineSummary, durationMs: number, logPath: string, cancelledIgnored = 0): void {
  const { counts } = summary;
  const succeeded = counts.deleted + counts.alreadyGone;
  log.plain();
  log.plain(pc.bold("Summary"));
  log.plain(
    keyValueBlock([
      ["Clones found", String(counts.found)],
      ...(cancelledIgnored ? [["Cancelled ignored", `${cancelledIgnored} (already deleted; never touched)`] as [string, string]] : []),
      ["Deleted", pc.green(String(counts.deleted))],
      ["Already gone", String(counts.alreadyGone)],
      ["Skipped", counts.skippedCovered ? `${counts.skippedCovered} (exceptions removed with their recurring series)` : "0"],
      ["Failed", counts.failed ? pc.red(String(counts.failed)) : "0"],
      ...(counts.notAttempted ? [["Not attempted", pc.red(`${counts.notAttempted} (run stopped early)`)] as [string, string]] : []),
      ["Retried", String(counts.retried)],
      ["Succeeded / total", `${succeeded + counts.skippedCovered} / ${counts.found}`],
      ["Listing", summary.listingComplete ? pc.green("complete") : pc.red("INCOMPLETE: run the tool again to catch the rest")],
      ...(summary.stoppedReason ? [["Stopped", pc.red(summary.stoppedReason)] as [string, string]] : []),
      ["Duration", formatDuration(durationMs)],
      ["Request log", logPath],
    ])
  );

  if (summary.failures.length) {
    log.plain();
    log.plain(pc.bold(pc.red(`Failed deletions (${summary.failures.length})`)));
    const rows = summary.failures.slice(0, MAX_FAILURES_SHOWN).map(({ event, result }) => [
      truncateText(event.id, 44),
      truncateText(event.title, 28),
      result.statusCode ? String(result.statusCode) : "-",
      truncateText(result.error, 70),
    ]);
    log.plain(table(["Event ID", "Title", "Status", "Error"], rows));
    if (summary.failures.length > MAX_FAILURES_SHOWN) {
      log.plain(pc.dim(`  … ${summary.failures.length - MAX_FAILURES_SHOWN} more in the log file`));
    }
  }
}
