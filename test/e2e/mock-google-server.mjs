/**
 * Minimal Google Calendar mock for exercising the real CLI end to end.
 * - 3 pages of events, each page delayed so listing is visibly slow
 * - page 1 has 60 clones (more than one batch) and 2 real events
 * - batch endpoint answers 204 for most, 410 for ids containing "gone", 403 once for "flaky"
 *
 * Usage: node mock-google-server.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || 4545);
// Behaviour knobs for end-to-end runs.
const CONFLICT_AFTER_SERIES = process.env.MOCK_CONFLICT_AFTER_SERIES === "1"; // next batch after a series delete answers 409 for all parts
const EXPIRE_AFTER_BATCHES = Number(process.env.MOCK_EXPIRE_AFTER_BATCHES || 0); // token "good-token" stops working after N batches; "fresh-token" works
let batchesSeen = 0;
let seriesDeletedInPreviousBatch = false;
const PAGE_DELAY_MS = Number(process.env.MOCK_PAGE_DELAY_MS || 1500);
const deleted = [];
let flakyFailed = false;

const clone = (id, extra = {}) => ({
  id,
  summary: `Clone ${id}`,
  status: "confirmed",
  start: { dateTime: "2026-10-30T10:00:00Z" },
  end: { dateTime: "2026-10-30T11:00:00Z" },
  extendedProperties: { private: { onecal_createdByOneCal: "true", onecal_sync_id: "sync_abc", onecal_source_id: `src_${id}` } },
  ...extra,
});
const series = (id) => clone(id, { recurrence: ["RRULE:FREQ=WEEKLY"] });
const exception = (masterId, n) => clone(`${masterId}_2026110${n}T100000Z`, { recurringEventId: masterId });
// Google keeps returning cancelled tombstones of clones deleted long ago; the
// CLI must ignore them and never try to delete them.
const tombstone = (id) => ({ ...clone(id), status: "cancelled" });
const pages = [
  [...Array.from({ length: 60 }, (_, i) => clone(`p1-${i}`)), { id: "real-1", summary: "Real meeting" }, clone("p1-gone"), ...Array.from({ length: 1500 }, (_, i) => tombstone(`dead1-${i}`)),
    // a recurring clone series with 5 exceptions: only the master should be requested
    exception("ser-1", 1), series("ser-1"), exception("ser-1", 2), exception("ser-1", 3), exception("ser-1", 4), exception("ser-1", 5)],
  Array.from({ length: 2500 }, (_, i) => tombstone(`dead2-${i}`)),
  [clone("p3-flaky"), clone("p3-1"), { id: "real-2", summary: "Dentist" }, ...Array.from({ length: 800 }, (_, i) => tombstone(`dead3-${i}`))],
];

const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const tokenOk = token === "fresh-token" || (token === "good-token" && !(EXPIRE_AFTER_BATCHES && batchesSeen >= EXPIRE_AFTER_BATCHES));
  if (!tokenOk) return json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
  if (req.headers.authorization === "Bearer fresh-token" || !EXPIRE_AFTER_BATCHES) { /* ok */ }

  if (req.method === "GET" && url.pathname === "/calendar/v3/users/me/calendarList/support%40example.com") {
    return json(res, 200, { id: "support@example.com", summary: "Support test calendar" });
  }
  if (req.method === "GET" && url.pathname === "/calendar/v3/calendars/support%40example.com/events") {
    if (url.searchParams.get("privateExtendedProperty") !== "onecal_createdByOneCal=true") return json(res, 400, { error: { message: "missing filter" } });
    const token = url.searchParams.get("pageToken");
    const index = token ? Number(token) : 0;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const body = { items: pages[index] };
    if (index + 1 < pages.length) body.nextPageToken = String(index + 1);
    return json(res, 200, body);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/calendar/v3/calendars/")) {
    const id = decodeURIComponent(url.pathname.split("/events/")[1]);
    if (id.startsWith("dead")) { console.error("BUG: delete requested for cancelled tombstone", id); process.exitCode = 9; }
    deleted.push(id);
    res.writeHead(id.includes("gone") ? 410 : 204); return res.end();
  }
  if (req.method === "POST" && url.pathname === "/batch/calendar/v3") {
    const body = await readBody(req);
    const boundary = /boundary=([^;\s]+)/.exec(req.headers["content-type"])[1];
    const parts = body.split(`--${boundary}`).filter((p) => p.includes("Content-ID"));
    batchesSeen++;
    const conflictThisBatch = CONFLICT_AFTER_SERIES && seriesDeletedInPreviousBatch;
    seriesDeletedInPreviousBatch = false;
    const out = parts.map((part) => {
      const id = /Content-ID: <([^>]+)>/.exec(part)[1];
      const eventId = decodeURIComponent(/DELETE \S+\/events\/(\S+)/.exec(part)[1]);
      if (eventId.includes("_2026")) { console.error("BUG: delete requested for an exception whose master is a clone", eventId); process.exitCode = 9; }
      let status = 204;
      if (conflictThisBatch) status = 409;
      if (status === 204 && eventId.startsWith("ser-")) seriesDeletedInPreviousBatch = true;
      if (eventId.includes("gone")) status = 410;
      if (eventId.includes("flaky") && !flakyFailed) { status = 403; flakyFailed = true; }
      if (eventId.startsWith("dead")) { console.error("BUG: delete requested for cancelled tombstone", eventId); process.exitCode = 9; }
      if (status === 204) deleted.push(eventId);
      const b = status >= 400 ? JSON.stringify({ error: { code: status, message: status === 403 ? "Rate Limit Exceeded" : status === 409 ? "Conflict" : status === 401 ? "Invalid Credentials" : "Resource has been deleted" } }) : "";
      return `--rb\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${b}\r\n`;
    });
    res.writeHead(200, { "content-type": "multipart/mixed; boundary=rb" });
    return res.end(out.join("") + "--rb--\r\n");
  }
  if (url.pathname === "/__deleted") return json(res, 200, { deleted });
  json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
}).listen(port, () => console.log(`mock google listening on ${port}`));
