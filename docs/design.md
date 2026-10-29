# OneCal clone CLI: design notes

## Intent

Support engineers need to remove OneCal clone events from a customer's calendar (for
example after a sync was deleted while clones were left behind) without touching real
events, and to see what clones exist before doing so. This tool does that for one
calendar at a time, with enough logging to troubleshoot afterwards.

## Clone detection (copied from mono/apps/sync-service)

| Provider | Server-side filter                                                     | Client-side check before delete                  |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Google   | `privateExtendedProperty=onecal_createdByOneCal=true`, 2500/page, ≤250 pages | `extendedProperties.private.onecal_createdByOneCal === "true"` and `status !== "cancelled"` |
| Outlook  | `$filter=extensions/any(f:f/id eq 'Microsoft.OutlookServices.OpenTypeExtension.io.onecal')` with the extension expanded, 100/page, ≤500 pages | extension `onecal_createdByOneCal === "true"`, `type !== "occurrence"` |
| CalDAV   | calendar-query for VEVENT hrefs (optionally time-ranged), multiget in chunks of 100 | any VEVENT has `X-ONECAL_CREATEDBYONECAL: true` (or the underscore-less variant) or the UID is in the `oc1.…` clone format |

Nothing is deleted unless the client-side check passed on the item itself.

Google tombstones: events with `status: "cancelled"` are clones that were already deleted.
Google can return thousands of them for one calendar. The request sends `showDeleted=false`,
each page is reduced to slim `CloneEvent`s before the next page is read (the raw payload is
never retained), and the cancelled count is surfaced per page and in the summary. The
pipeline keeps only id + outcome per processed event, so memory stays flat on big runs.

## Streaming pipeline (`src/core/pipeline.ts`)

Google applies the extended-property filter after paging, so listing walks the whole
calendar and can take minutes. The producer (`listClones`, an async generator yielding
pages) and the consumer (delete workers) run concurrently over a shared queue:

- each page is appended to the queue as it arrives and workers are woken;
- workers take `batchSize` items (Google 50, Outlook 20, CalDAV 1) or one in non-batch
  mode;
- CalDAV has no batch API, so batch mode runs 5 workers concurrently instead;
- transient failures (`retriable: true`) are re-queued up to 3 attempts;
- if listing throws (incomplete read), workers still drain what was found and the summary
  reports the listing as incomplete.

Outcomes per event: `deleted`, `already_gone` (404 / 410, e.g. an exception whose series
master was already deleted), `failed`, or skipped (an exception instance covered by its
series master).

### Findings from a 35,000-clone Google run (2026-10-29) and what they changed

- 46 of 242 batches answered 409 Conflict for every part. They were fast (about 4 s), and
  each followed an unusually slow batch (about 11 s), i.e. one that deleted recurring
  series. Google is still cascading those deletes when the next batch lands and rejects
  its writes to the same calendar. 409 is now retriable (5 s × attempt), the pipeline
  pauses 3 s after a batch containing a recurring master, and 10 s after any conflict.
- 6,486 of 12,100 requests were for exception instances whose master was in the same
  clone list, which produced all the 410s. Instances are now routed through a per-master
  buffer: skipped when the master is a known clone (before or after it arrives), queued
  at the end of listing when the master never appears, and queued again if the master's
  delete fails permanently.
- The token expired after about 28 minutes; 3,500 parts then failed with 401 while the
  run kept going. A 401 now pauses the workers (and listing), prompts for a fresh
  credential through `CloneProvider.updateCredentials`, re-queues the affected items
  without counting an attempt, and restarts the listing with id-based deduplication.

## HTTP

- `src/http/client.ts` wraps fetch for Google/Outlook: bearer auth, 4 rps limiter, retries
  (429, 5xx, network, Google 403) honouring `Retry-After`, full JSONL logging.
- CalDAV goes through `tsdav` with a logging fetch wrapper that applies the same limiter,
  retries and logging. Login falls back to mono's calendar-home-set discovery for servers
  tsdav cannot log into directly.

## Logging

`src/logging/file-logger.ts` appends one JSON object per line: every request and response
(redacted), run milestones, and each delete result. The console shows timestamped lines
for pages, batches, retries and failures, plus a spinner status line with elapsed time and
an idle warning so long requests never look stuck.

## Decisions made without the user

- Standalone package (own `package.json`), not a workspace member of mono, so it can be
  run from a support laptop without the database or env of the sync service.
- CalDAV asks for server URL / username / app password instead of an "access token".
- The delete confirmation requires typing `delete`; flags cannot skip it.
- Rate limit fixed at 4 rps (mono's low setting) for all providers.
