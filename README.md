# OneCal clone CLI

Support tool that **lists** or **deletes OneCal clone events** in a single calendar on
Google, Outlook or CalDAV. It only ever touches events the OneCal sync service created;
the detection rules are copied from `mono/apps/sync-service` (see
[docs/design.md](docs/design.md)).

## Setup

```bash
cd clone-cli
npm install
npm start            # interactive
```

Requires Node 20 or newer.

## Interactive flow

1. Choose the operation: **List clone events** or **Delete clone events**.
2. Choose the provider: Google, Outlook or CalDAV.
3. Enter the calendar ID (for CalDAV this is the calendar URL).
4. Enter the credentials:
   - Google / Outlook: an access token (input is hidden).
   - CalDAV: server URL, username and app password (CalDAV has no bearer tokens).
5. Operation-specific inputs:
   - Delete: **Batch** or **Non-batch** mode.
   - CalDAV: scan 1 year back / 1 year ahead (the sync service's window) or the whole calendar.
6. The tool connects, looks the calendar up and prints its name.
7. For deletes, a final confirmation shows the calendar name, provider, ID and mode. Type
   `delete` to proceed; anything else aborts with nothing changed.

Cancelled Google events (`status: "cancelled"`) are tombstones of clones that were already
deleted. Google can return thousands of them when filtering by extended property, so the
tool asks for `showDeleted=false`, drops any that still arrive before they are counted or
queued, and reports them per page and in the summary as "cancelled ignored".

Listing and deleting run **in parallel**: the first page of clones is deleted while later
pages are still being read, so a slow Google read never blocks progress.

## Non-interactive use

Flags and environment variables pre-fill prompts. The delete confirmation is always asked.

```bash
CLONE_CLI_ACCESS_TOKEN=ya29... npm start -- --op list --provider google --calendar-id primary
CLONE_CLI_ACCESS_TOKEN=eyJ... npm start -- --op delete --provider outlook --calendar-id AAMk... --mode batch

CLONE_CLI_CALDAV_SERVER_URL=https://caldav.icloud.com \
CLONE_CLI_CALDAV_USERNAME=user@icloud.com \
CLONE_CLI_CALDAV_PASSWORD=xxxx-xxxx-xxxx-xxxx \
npm start -- --op list --provider caldav --calendar-id https://caldav.icloud.com/123/calendars/ABC/ --range 1y
```

Run `npm start -- --help` for the full list.

## What "batch" means per provider

| Provider | Batch mode                                   | Non-batch mode            |
| -------- | -------------------------------------------- | ------------------------- |
| Google   | multipart batch endpoint, 50 deletes/request | one DELETE per clone      |
| Outlook  | Graph `$batch`, 20 deletes/request           | one DELETE per clone      |
| CalDAV   | no batch API: 5 concurrent DELETEs           | one DELETE at a time      |

Requests are rate limited to 4 per second (mono's "low" setting) and retried on 429,
409, 5xx, network errors and Google 403 rate limits, honouring `Retry-After`. Failed
deletes that look transient are re-queued up to 3 attempts, with a delay of 5 s times the
attempt number.

### Behaviour learned from large Google runs

- **Exceptions of recurring clones are not requested.** Deleting a recurring master
  deletes its exception instances (ids like `master_20261029T100000Z`), so an instance is
  skipped whenever its master is also a clone. It is deleted on its own only if the master
  never shows up as a clone, or if deleting the master fails permanently. The summary
  reports these as "Skipped".
- **409 Conflict is retried.** Google answers 409 for every part of a batch sent while it
  is still cascading the previous batch's series deletes. The affected clones are retried
  after a delay and the pipeline backs off 10 s before the next batch.
- **Pacing after series deletes.** After any batch that contained a recurring master the
  pipeline waits 3 s before sending the next one.
- **Expired token.** On the first 401 the run pauses and asks for a fresh token (or CalDAV
  app password). Paste one and the run resumes exactly where it was, including the
  listing; leave it empty and the run stops, reporting how many clones were not attempted.

## Output

- Timestamped log lines for every page read, every batch, every failure and every retry.
- A live status line with elapsed time; it warns when no response has arrived for 8 s.
- A final summary: found, deleted, already gone, failed, retried, succeeded/total,
  whether the listing completed, duration and the log path. Failed deletions are listed
  with their status code and error.

## Troubleshooting log

Every run writes a JSONL file with **every request and response** (headers, bodies up to
20 KB, status, duration), plus the tool's own milestones and each delete result.
Authorization headers and passwords are redacted.

- Default location: `~/.onecal-clone-cli/logs/<timestamp>_<op>_<provider>.jsonl`
- Override with `--log-dir` or `CLONE_CLI_LOG_DIR`.
- The list operation also writes `<timestamp>_list_<provider>_clones.json` with the full
  clone list next to the log.

## Development

```bash
npm test         # vitest unit + provider tests (fake fetch, no network)
npm run typecheck
npm run build    # emits dist/, runnable with `node dist/index.js`
```

`CLONE_CLI_GOOGLE_BASE_URL`, `CLONE_CLI_GOOGLE_BATCH_URL` and `CLONE_CLI_OUTLOOK_BASE_URL`
point the providers at a mock server for end-to-end runs (see `test/e2e/`).

### End-to-end check against a mock Google server

```bash
npm run build
node test/e2e/mock-google-server.mjs 4545 &          # slow 3-page listing, 63 clones, 2 real events
/usr/bin/expect -f test/e2e/run-google-delete.exp 4545 /tmp/clone-cli-logs   # types "delete"
/usr/bin/expect -f test/e2e/run-google-abort.exp 4545 /tmp/clone-cli-logs    # types "no": nothing deleted
curl -s -H 'Authorization: Bearer good-token' http://localhost:4545/__deleted
```
