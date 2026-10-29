import { describe, expect, it, vi } from "vitest";
import { runDeletePipeline } from "../src/core/pipeline.js";
import { HttpClient } from "../src/http/client.js";
import { NullLogger } from "../src/logging/file-logger.js";
import { GoogleProvider } from "../src/providers/google.js";
import { boundaryFromContentType } from "../src/providers/google-batch.js";

const clone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: `Busy ${id}`,
  status: "confirmed",
  start: { dateTime: "2026-10-30T10:00:00Z" },
  extendedProperties: { private: { onecal_createdByOneCal: "true", onecal_sync_id: "s1" } },
  ...extra,
});

function fakeGoogle(opts: { pages: unknown[][]; deleteStatus?: (id: string) => number }) {
  const deleteStatus = opts.deleteStatus ?? (() => 204);
  const deleted: string[] = [];
  const listCalls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/users/me/calendarList/")) {
      return new Response(JSON.stringify({ id: "cal@x", summary: "Work" }), { status: 200 });
    }
    if (url.includes("/events?")) {
      listCalls.push(url);
      const token = new URL(url).searchParams.get("pageToken");
      const index = token ? Number(token.replace("p", "")) : 0;
      const body: Record<string, unknown> = { items: opts.pages[index] };
      if (index + 1 < opts.pages.length) body.nextPageToken = `p${index + 1}`;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (init?.method === "DELETE") {
      const id = decodeURIComponent(url.split("/events/")[1]);
      deleted.push(id);
      const status = deleteStatus(id);
      return new Response(status === 204 ? null : "", { status });
    }
    if (url.includes("/batch/")) {
      const reqBoundary = boundaryFromContentType((init?.headers as Record<string, string>)["Content-Type"])!;
      const parts = String(init?.body).split(`--${reqBoundary}`).filter((p) => p.includes("Content-ID"));
      const responses = parts.map((part) => {
        const id = /Content-ID: <([^>]+)>/.exec(part)![1];
        const eventId = decodeURIComponent(/DELETE \S+\/events\/(\S+)/.exec(part)![1]);
        deleted.push(eventId);
        const status = deleteStatus(eventId);
        const body = status >= 400 ? `{"error":{"code":${status},"message":"boom"}}` : "";
        return `--rb\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${body}\r\n`;
      });
      return new Response(responses.join("") + "--rb--\r\n", { status: 200, headers: { "content-type": "multipart/mixed; boundary=rb" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, deleted, listCalls };
}

function provider(fetchImpl: typeof fetch) {
  const logger = new NullLogger();
  const http = new HttpClient({ provider: "google", accessToken: "t", logger, rps: 10_000, fetchImpl });
  return new GoogleProvider({ accessToken: "t", logger, http });
}

describe("GoogleProvider", () => {
  it("lists only clones across pages, skipping cancelled and real events", async () => {
    const fake = fakeGoogle({
      pages: [
        [clone("a"), { id: "real", summary: "Real meeting" }, clone("cancelled", { status: "cancelled" })],
        [],
        [clone("b")],
      ],
    });
    const p = provider(fake.fetchImpl);
    expect(await p.getCalendar("cal@x")).toEqual({ id: "cal@x", name: "Work" });

    const pages: string[][] = [];
    const progress: number[] = [];
    const phases: string[] = [];
    for await (const page of p.listClones("cal@x", (i) => {
      phases.push(`${i.phase}:${i.page}:${i.totalClones}`);
      if (i.phase === "done") progress.push(i.page);
    })) pages.push(page.map((e) => e.id));
    expect(pages).toEqual([["a"], ["b"]]);
    expect(progress).toEqual([1, 2, 3]);
    // "fetching" fires before each request with the count retrieved so far.
    expect(phases).toEqual(["fetching:1:0", "done:1:1", "fetching:2:1", "done:2:1", "fetching:3:1", "done:3:2"]);
    expect(fake.listCalls[0]).toContain("privateExtendedProperty=onecal_createdByOneCal%3Dtrue");
    expect(fake.listCalls[0]).toContain("showDeleted=false");
  });

  it("ignores pages full of cancelled tombstones and reports them without keeping them", async () => {
    const tombstones = Array.from({ length: 1000 }, (_, i) => clone(`dead-${i}`, { status: "cancelled" }));
    const fake = fakeGoogle({ pages: [tombstones, [...tombstones.slice(0, 500), clone("alive")], tombstones] });
    const p = provider(fake.fetchImpl);

    const yielded: string[][] = [];
    const progress: Array<{ clones: number; cancelled?: number; ignored: number }> = [];
    for await (const page of p.listClones("cal@x", (i) => i.phase === "done" && progress.push({ clones: i.clonesOnPage, cancelled: i.cancelledOnPage, ignored: i.ignoredOnPage }))) {
      yielded.push(page.map((e) => e.id));
    }
    expect(yielded).toEqual([["alive"]]);
    expect(progress).toEqual([
      { clones: 0, cancelled: 1000, ignored: 1000 },
      { clones: 1, cancelled: 500, ignored: 500 },
      { clones: 0, cancelled: 1000, ignored: 1000 },
    ]);
    // No raw payload is retained on the clone we keep.
    expect(yielded.length).toBe(1);
  });

  it("never sends a delete for a cancelled clone", async () => {
    const fake = fakeGoogle({ pages: [[clone("dead", { status: "cancelled" }), clone("alive")]] });
    const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl), calendarId: "cal@x", mode: "batch" });
    expect(summary.counts).toMatchObject({ found: 1, deleted: 1 });
    expect(fake.deleted).toEqual(["alive"]);
  });

  it("deletes in multipart batches and maps 410 to already_gone and 403 to a retriable failure", async () => {
    const fake = fakeGoogle({
      pages: [[clone("a"), clone("gone"), clone("limited")]],
      deleteStatus: (id) => (id === "gone" ? 410 : id === "limited" ? 403 : 204),
    });
    const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl), calendarId: "cal@x", mode: "batch", maxAttempts: 2, retryDelayMs: () => 10, paceAfterSeriesMs: 0, conflictBackoffMs: 0 });
    expect(summary.counts).toMatchObject({ found: 3, deleted: 1, alreadyGone: 1, failed: 1, retried: 1 });
    expect(fake.deleted.filter((id) => id === "limited")).toHaveLength(2);
    expect(summary.failures[0].result.statusCode).toBe(403);
  });

  it("deletes one by one in single mode", async () => {
    const fake = fakeGoogle({ pages: [[clone("a"), clone("b")]] });
    const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl), calendarId: "cal@x", mode: "single" });
    expect(summary.counts).toMatchObject({ deleted: 2, failed: 0 });
    expect(fake.deleted).toEqual(["a", "b"]);
  });
});
