import { describe, expect, it } from "vitest";
import { collectClones, runDeletePipeline } from "../src/core/pipeline.js";
import type { CloneEvent, CloneProvider, DeleteResult } from "../src/providers/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (id: string, extra: Partial<CloneEvent> = {}): CloneEvent => ({ id, title: `clone ${id}`, ...extra });
const master = (id: string) => ev(id, { isRecurring: true });
const instance = (masterId: string, n: number) => ev(`${masterId}_2026110${n}T100000Z`, { recurringEventId: masterId });
const fast = { retryDelayMs: () => 10, paceAfterSeriesMs: 0, conflictBackoffMs: 0 };

class FakeProvider implements CloneProvider {
  readonly name = "google" as const;
  readonly label = "Fake";
  readonly batchSize = 2;
  readonly batchHint = "";
  readonly credentialLabel = "access token";
  credential = "old";
  updateCredentials(secret: string) {
    this.credential = secret;
  }
  deleteCalls: string[][] = [];
  /** ids that answer 401 while the credential is still "old". */
  needsFreshToken = new Set<string>();
  /** throw a 401 from listing until the credential is refreshed. */
  listNeedsFreshToken = false;
  conflictOnce = new Set<string>();
  listFinishedAt = 0;
  firstDeleteAt = 0;
  failOnce = new Set<string>();
  alwaysFail = new Set<string>();

  constructor(private pages: CloneEvent[][], private pageDelayMs = 20, private listError?: Error) {}

  async getCalendar(id: string) {
    return { id, name: "Fake calendar" };
  }

  async *listClones(_calendarId: string, onProgress?: (i: { phase: "fetching" | "done"; page: number; itemsOnPage: number; clonesOnPage: number; ignoredOnPage: number; totalClones: number }) => void) {
    let total = 0;
    for (let i = 0; i < this.pages.length; i++) {
      await sleep(this.pageDelayMs);
      if (this.listNeedsFreshToken && this.credential === "old" && i === 1) {
        throw Object.assign(new Error("401 invalid credentials"), { status: 401 });
      }
      total += this.pages[i].length;
      onProgress?.({ phase: "done", page: i + 1, itemsOnPage: this.pages[i].length, clonesOnPage: this.pages[i].length, ignoredOnPage: 0, totalClones: total });
      yield this.pages[i];
    }
    if (this.listError) throw this.listError;
    this.listFinishedAt = Date.now();
  }

  private outcome(event: CloneEvent): DeleteResult {
    if (this.needsFreshToken.has(event.id) && this.credential === "old") {
      return { id: event.id, status: "failed", statusCode: 401, retriable: false, error: "invalid credentials" };
    }
    if (this.conflictOnce.has(event.id)) {
      this.conflictOnce.delete(event.id);
      return { id: event.id, status: "failed", statusCode: 409, retriable: true, error: "409 Conflict" };
    }
    if (this.alwaysFail.has(event.id)) return { id: event.id, status: "failed", statusCode: 400, retriable: false, error: "bad" };
    if (this.failOnce.has(event.id)) {
      this.failOnce.delete(event.id);
      return { id: event.id, status: "failed", statusCode: 429, retriable: true, error: "rate limited" };
    }
    if (event.id.startsWith("gone")) return { id: event.id, status: "already_gone", statusCode: 410 };
    return { id: event.id, status: "deleted", statusCode: 204 };
  }

  async deleteClone(_calendarId: string, event: CloneEvent) {
    this.firstDeleteAt ||= Date.now();
    this.deleteCalls.push([event.id]);
    await sleep(5);
    return this.outcome(event);
  }

  async batchDeleteClones(_calendarId: string, events: CloneEvent[]) {
    this.firstDeleteAt ||= Date.now();
    this.deleteCalls.push(events.map((e) => e.id));
    await sleep(5);
    return events.map((e) => this.outcome(e));
  }
}

describe("runDeletePipeline", () => {
  it("starts deleting before listing has finished and deletes everything", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b"), ev("c")], [ev("d")], [ev("gone-e")]], 40);
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "batch" });

    expect(provider.firstDeleteAt).toBeGreaterThan(0);
    expect(provider.firstDeleteAt).toBeLessThan(provider.listFinishedAt);
    expect(summary.counts).toMatchObject({ found: 5, deleted: 4, alreadyGone: 1, failed: 0, pending: 0 });
    expect(summary.listingComplete).toBe(true);
    // batch size 2: a,b | c | d | gone-e (order of chunks depends on timing but sizes never exceed 2)
    expect(provider.deleteCalls.every((call) => call.length <= 2)).toBe(true);
    expect(provider.deleteCalls.flat().sort()).toEqual(["a", "b", "c", "d", "gone-e"]);
  });

  it("uses one request per event in single mode", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b"), ev("c")]], 1);
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "single" });
    expect(provider.deleteCalls).toEqual([["a"], ["b"], ["c"]]);
    expect(summary.counts.deleted).toBe(3);
  });

  it("re-queues retriable failures and reports permanent ones", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b"), ev("c")]], 1);
    provider.failOnce.add("a");
    provider.alwaysFail.add("c");
    const seen: string[] = [];
    const summary = await runDeletePipeline({
      provider,
      calendarId: "cal",
      mode: "single",
      ...fast,
      events: { onResult: (e, r, attempt) => seen.push(`${e.id}:${r.status}:${attempt}`) },
    });
    expect(summary.counts).toMatchObject({ found: 3, deleted: 2, failed: 1, retried: 1, pending: 0 });
    expect(summary.failures.map((f) => f.event.id)).toEqual(["c"]);
    expect(seen).toContain("a:failed:1");
    expect(seen).toContain("a:deleted:2");
  });

  it("gives up on a retriable failure after maxAttempts", async () => {
    const provider = new FakeProvider([[ev("a")]], 1);
    provider.failOnce.add("a");
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "single", maxAttempts: 1 });
    expect(summary.counts).toMatchObject({ deleted: 0, failed: 1, retried: 0 });
  });

  it("keeps deleting what was already found when listing fails midway", async () => {
    const provider = new FakeProvider([[ev("a")], [ev("b")]], 5, new Error("read ended before last page"));
    let listError: unknown;
    const summary = await runDeletePipeline({
      provider,
      calendarId: "cal",
      mode: "batch",
      events: { onListError: (err) => (listError = err) },
    });
    expect(summary.listingComplete).toBe(false);
    expect((listError as Error).message).toContain("read ended");
    expect(summary.counts).toMatchObject({ found: 2, deleted: 2, pending: 0 });
  });

  it("runs several workers concurrently when asked", async () => {
    const provider = new FakeProvider([Array.from({ length: 6 }, (_, i) => ev(String(i)))], 1);
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "single", concurrency: 3 });
    expect(summary.counts.deleted).toBe(6);
  });
});

describe("series-aware skipping", () => {
  it("skips exception instances whose master is a clone, whichever arrives first", async () => {
    const provider = new FakeProvider([[instance("m1", 1), master("m1"), instance("m1", 2)], [instance("m1", 3), master("m2")], [instance("m2", 1)]], 1);
    const skipped: string[] = [];
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "batch", ...fast, events: { onSkipped: (e) => skipped.push(e.id) } });
    expect(provider.deleteCalls.flat().sort()).toEqual(["m1", "m2"]);
    expect(skipped.sort()).toEqual(["m1_20261101T100000Z", "m1_20261102T100000Z", "m1_20261103T100000Z", "m2_20261101T100000Z"]);
    expect(summary.counts).toMatchObject({ found: 6, deleted: 2, skippedCovered: 4, failed: 0, pending: 0 });
  });

  it("deletes an instance on its own when its master never shows up as a clone", async () => {
    const provider = new FakeProvider([[instance("real-series", 1), ev("x")]], 1);
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "batch", ...fast });
    expect(provider.deleteCalls.flat().sort()).toEqual(["real-series_20261101T100000Z", "x"]);
    expect(summary.counts).toMatchObject({ found: 2, deleted: 2, skippedCovered: 0 });
  });

  it("falls back to deleting the instances when the master fails for good", async () => {
    const provider = new FakeProvider([[master("m1"), instance("m1", 1), instance("m1", 2)]], 1);
    provider.alwaysFail.add("m1");
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "batch", ...fast });
    expect(provider.deleteCalls.flat().sort()).toEqual(["m1", "m1_20261101T100000Z", "m1_20261102T100000Z"]);
    expect(summary.counts).toMatchObject({ found: 3, deleted: 2, failed: 1, skippedCovered: 0 });
  });
});

describe("conflicts and pacing", () => {
  it("retries a 409 after the retry delay and backs off after the batch", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b"), ev("c")]], 1);
    provider.conflictOnce.add("a").add("b");
    const pauses: string[] = [];
    const scheduled: number[] = [];
    const summary = await runDeletePipeline({
      provider,
      calendarId: "cal",
      mode: "batch",
      retryDelayMs: () => 30,
      paceAfterSeriesMs: 0,
      conflictBackoffMs: 40,
      events: { onPause: (p) => pauses.push(p.reason), onRetryScheduled: (_e, _r, _a, d) => scheduled.push(d) },
    });
    expect(summary.counts).toMatchObject({ deleted: 3, failed: 0, retried: 2 });
    expect(pauses).toEqual(["conflict"]);
    expect(scheduled).toEqual([30, 30]);
    expect(provider.deleteCalls.flat().filter((id) => id === "a")).toHaveLength(2);
  });

  it("pauses after a batch that deleted a recurring master", async () => {
    const provider = new FakeProvider([[master("m1"), ev("b")], [ev("c")]], 1);
    const pauses: string[] = [];
    const t0 = Date.now();
    await runDeletePipeline({ provider, calendarId: "cal", mode: "batch", retryDelayMs: () => 10, paceAfterSeriesMs: 60, conflictBackoffMs: 0, events: { onPause: (p) => pauses.push(p.reason) } });
    expect(pauses).toEqual(["series"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe("expired credentials", () => {
  it("pauses on 401, asks for a new credential, and re-queues the items without counting an attempt", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b")], [ev("c")]], 1);
    provider.needsFreshToken.add("a").add("b");
    const attempts: string[] = [];
    let asked = 0;
    const summary = await runDeletePipeline({
      provider,
      calendarId: "cal",
      mode: "batch",
      ...fast,
      events: {
        onAuthExpired: async () => {
          asked++;
          provider.updateCredentials("new");
          return true;
        },
        onResult: (e, r, attempt) => attempts.push(`${e.id}:${r.status}:${attempt}`),
      },
    });
    expect(asked).toBe(1);
    expect(summary.counts).toMatchObject({ found: 3, deleted: 3, failed: 0, retried: 0, notAttempted: 0 });
    expect(summary.stoppedReason).toBeUndefined();
    expect(attempts.filter((a) => a.startsWith("a:"))).toEqual(["a:deleted:1"]);
  });

  it("stops and reports what was left when no new credential is given", async () => {
    const provider = new FakeProvider([[ev("a"), ev("b"), ev("c"), ev("d")]], 1);
    provider.needsFreshToken.add("a");
    const summary = await runDeletePipeline({ provider, calendarId: "cal", mode: "batch", ...fast, events: { onAuthExpired: async () => false } });
    expect(summary.stoppedReason).toContain("token");
    expect(summary.counts.deleted + summary.counts.notAttempted).toBe(4);
    expect(summary.counts.notAttempted).toBeGreaterThan(0);
    expect(summary.listingComplete).toBe(true);
  });

  it("restarts listing after a 401 during listing and does not queue duplicates", async () => {
    const provider = new FakeProvider([[ev("a")], [ev("b")], [ev("c")]], 1);
    provider.listNeedsFreshToken = true;
    let restarted = 0;
    const summary = await runDeletePipeline({
      provider,
      calendarId: "cal",
      mode: "batch",
      ...fast,
      events: {
        onAuthExpired: async () => {
          provider.updateCredentials("new");
          return true;
        },
        onListRestart: () => restarted++,
      },
    });
    expect(restarted).toBe(1);
    expect(summary.counts).toMatchObject({ found: 3, deleted: 3 });
    expect(summary.listingComplete).toBe(true);
    expect(provider.deleteCalls.flat().sort()).toEqual(["a", "b", "c"]);
  });
});

describe("collectClones", () => {
  it("gathers every page", async () => {
    const provider = new FakeProvider([[ev("a")], [ev("b"), ev("c")]], 1);
    const all = await collectClones(provider, "cal");
    expect(all.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});
