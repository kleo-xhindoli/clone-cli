import { describe, expect, it, vi } from "vitest";
import { ONECAL_ID, OUTLOOK_EXTENSION_ID } from "../src/core/clone-detection.js";
import { runDeletePipeline } from "../src/core/pipeline.js";
import { HttpClient } from "../src/http/client.js";
import { NullLogger } from "../src/logging/file-logger.js";
import { OutlookProvider } from "../src/providers/outlook.js";

const clone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Busy ${id}`,
  type: "singleInstance",
  start: { dateTime: "2026-10-30T10:00:00.0000000", timeZone: "UTC" },
  extensions: [{ id: OUTLOOK_EXTENSION_ID, onecal_createdByOneCal: "true", onecal_sync_id: "s1" }],
  ...extra,
});

function fakeGraph(opts: { pages: unknown[][]; deleteStatus?: (id: string) => number }) {
  const deleteStatus = opts.deleteStatus ?? (() => 204);
  const deleted: string[] = [];
  const batchSizes: number[] = [];
  const listUrls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/$batch")) {
      const { requests } = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; url: string }> };
      batchSizes.push(requests.length);
      const responses = requests.map((r) => {
        const id = decodeURIComponent(r.url.split("/events/")[1]);
        deleted.push(id);
        const status = deleteStatus(id);
        return { id: r.id, status, body: status >= 400 ? { error: { code: "ErrorItemNotFound", message: "nope" } } : null };
      });
      return new Response(JSON.stringify({ responses }), { status: 200 });
    }
    if (url.includes("/events?") || url.includes("page=")) {
      const index = url.includes("page=") ? Number(new URL(url).searchParams.get("page")) : 0;
      if (!url.includes("page=")) listUrls.push(url);
      const body: Record<string, unknown> = { value: opts.pages[index] };
      if (index + 1 < opts.pages.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0/next?page=${index + 1}`;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes("/me/calendars/") && init?.method === "DELETE") {
      const id = decodeURIComponent(url.split("/events/")[1]);
      deleted.push(id);
      const status = deleteStatus(id);
      return new Response(status === 204 ? null : "", { status });
    }
    if (url.includes("/me/calendars/")) {
      return new Response(JSON.stringify({ id: "AAMk", name: "Calendar" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, deleted, batchSizes, listUrls };
}

function provider(fetchImpl: typeof fetch, detection?: "standard" | "shared") {
  const logger = new NullLogger();
  const http = new HttpClient({ provider: "outlook", accessToken: "t", logger, rps: 10_000, fetchImpl });
  return new OutlookProvider({ accessToken: "t", logger, http, detection });
}

const signed = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Busy ${id}`,
  type: "singleInstance",
  body: { contentType: "html", content: `<html><body>Agenda<div id="${ONECAL_ID}"></div></body></html>` },
  ...extra,
});

describe("OutlookProvider", () => {
  it("lists clones across nextLink pages, ignoring occurrences and non-clones", async () => {
    const fake = fakeGraph({
      pages: [[clone("a"), { id: "real", subject: "Real" }, clone("occ", { type: "occurrence" })], [clone("b", { type: "seriesMaster" })]],
    });
    const p = provider(fake.fetchImpl);
    expect(await p.getCalendar("AAMk")).toEqual({ id: "AAMk", name: "Calendar" });
    const ids: string[] = [];
    for await (const page of p.listClones("AAMk")) ids.push(...page.map((e) => e.id));
    expect(ids).toEqual(["a", "b"]);
    const params = new URL(fake.listUrls[0]).searchParams;
    expect(params.get("$filter")).toBe(`extensions/any(f:f/id eq '${OUTLOOK_EXTENSION_ID}')`);
    expect(params.get("$expand")).toBe(`extensions($filter=id eq '${OUTLOOK_EXTENSION_ID}')`);
  });

  it("deletes through $batch in chunks of 20 and maps 404 to already_gone", async () => {
    const pages = [Array.from({ length: 25 }, (_, i) => clone(`e${i}`))];
    const fake = fakeGraph({ pages, deleteStatus: (id) => (id === "e3" ? 404 : 204) });
    const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl), calendarId: "AAMk", mode: "batch" });
    expect(summary.counts).toMatchObject({ found: 25, deleted: 24, alreadyGone: 1, failed: 0 });
    expect(fake.batchSizes).toEqual([20, 5]);
  });

  it("records a permanent failure for a 400 inside the batch", async () => {
    const fake = fakeGraph({ pages: [[clone("a"), clone("bad")]], deleteStatus: (id) => (id === "bad" ? 400 : 204) });
    const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl), calendarId: "AAMk", mode: "batch" });
    expect(summary.counts).toMatchObject({ deleted: 1, failed: 1, retried: 0 });
    expect(summary.failures[0].result.error).toContain("ErrorItemNotFound");
  });

  describe("shared calendar detection", () => {
    it("reads every event with its HTML body and keeps only those carrying the OneCal id", async () => {
      const fake = fakeGraph({
        pages: [
          [signed("a"), { id: "real", subject: "Real", body: { contentType: "html", content: "<p>hi</p>" } }, clone("meta-only")],
          [signed("occ", { type: "occurrence" }), signed("b", { type: "seriesMaster" })],
        ],
      });
      const p = provider(fake.fetchImpl, "shared");
      const ids: string[] = [];
      for await (const page of p.listClones("AAMk")) ids.push(...page.map((e) => e.id));
      expect(ids).toEqual(["a", "b"]);

      const params = new URL(fake.listUrls[0]).searchParams;
      expect(params.get("$filter")).toBeNull();
      expect(params.get("$select")?.split(",")).toContain("body");
      const init = (fake.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Prefer).toBe('outlook.body-content-type="html"');
    });

    it("deletes the signed clones it found", async () => {
      const fake = fakeGraph({ pages: [[signed("a"), { id: "real", subject: "Real" }, signed("b")]] });
      const summary = await runDeletePipeline({ provider: provider(fake.fetchImpl, "shared"), calendarId: "AAMk", mode: "batch" });
      expect(summary.counts).toMatchObject({ found: 2, deleted: 2, failed: 0 });
      expect(fake.deleted.sort()).toEqual(["a", "b"]);
    });
  });
});
