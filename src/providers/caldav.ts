/**
 * CalDAV provider (iCloud, Fastmail, Nextcloud, Zoho, ...).
 *
 * Listing mirrors mono's CalDavClient.getCalendarEvents: a calendar-query for
 * the object hrefs, then calendar-multiget in chunks. Each chunk is parsed and
 * yielded immediately so deletion can start while later chunks are still
 * being fetched. There is no batch API in CalDAV, so "batch" mode means a few
 * concurrent DELETEs instead of one at a time.
 */
import {
  DAVClient,
  createAccount,
  propfind,
  urlEquals,
  type DAVAccount,
  type DAVCalendar,
  type DAVObject,
  type DAVResponse,
} from "tsdav";
import { calDavToCloneEvent, parseCalDavObject } from "../core/clone-detection.js";
import { RateLimiter } from "../http/rate-limiter.js";
import { MAX_ATTEMPTS, isRetriableStatus, retryDelayMs, sleep } from "../http/retry.js";
import type { FileLogger } from "../logging/file-logger.js";
import {
  IncompleteReadError,
  type CalendarInfo,
  type CloneEvent,
  type CloneProvider,
  type DeleteResult,
  type ListProgress,
} from "./types.js";

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export interface CalDavTimeRange {
  /** ISO timestamps. Omit to scan the whole calendar. */
  start?: string;
  end?: string;
}

export interface CalDavProviderOptions {
  credentials: CalDavCredentials;
  logger: FileLogger;
  timeRange?: CalDavTimeRange;
  /** Hrefs per calendar-multiget. Zoho CRM rejects more than 100. */
  multiGetChunkSize?: number;
  onRetry?: (info: { attempt: number; maxAttempts: number; status?: number; delayMs: number; url: string }) => void;
  onParseWarning?: (message: string) => void;
}

const DEFAULT_MULTIGET_CHUNK = 100;
const HOME_URL_NOT_FOUND = "cannot find homeUrl";
const ALREADY_GONE = [404];

export class CalDavProvider implements CloneProvider {
  readonly name = "caldav" as const;
  readonly label = "CalDAV";
  /** No batch API: the pipeline deletes one object per request. */
  readonly batchSize = 1;
  readonly batchHint = "no batch API; runs 5 DELETE requests at a time";
  readonly credentialLabel = "app password";

  private client?: DAVClient;
  private calendarsCache?: DAVCalendar[];
  /** Status of the last failed response, so tsdav's terse errors can be explained. */
  private lastFailureStatus?: number;
  private readonly limiter = new RateLimiter(4);
  private readonly chunkSize: number;

  constructor(private readonly options: CalDavProviderOptions) {
    this.chunkSize = options.multiGetChunkSize ?? DEFAULT_MULTIGET_CHUNK;
  }

  updateCredentials(password: string): void {
    this.options.credentials.password = password;
    this.client = undefined;
  }

  // ------------------------------------------------------------ client

  private async getClient(): Promise<DAVClient> {
    if (this.client) return this.client;
    const { serverUrl, username, password } = this.options.credentials;
    const client = new DAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: this.loggingFetch(),
    });
    try {
      await this.login(client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wrapped =
        this.lastFailureStatus === 401 || this.lastFailureStatus === 403
          ? new Error(`CalDAV login failed (${this.lastFailureStatus}): check the server URL, username and app password. Server said: ${message}`)
          : new Error(`CalDAV login failed${this.lastFailureStatus ? ` (${this.lastFailureStatus})` : ""}: ${message}`);
      (wrapped as Error & { status?: number }).status = this.lastFailureStatus;
      throw wrapped;
    }
    this.client = client;
    return client;
  }

  /** client.login() with mono's calendar-home-set discovery fallback (cPanel etc). */
  private async login(client: DAVClient): Promise<void> {
    try {
      await client.login();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== HOME_URL_NOT_FOUND) throw err;
      client.account = await this.discoverAccount(client);
    }
  }

  private async discoverAccount(client: DAVClient): Promise<DAVAccount> {
    const request = { headers: client.authHeaders, fetchOptions: client.fetchOptions, fetch: client.fetchOverride };
    const account = await createAccount({
      account: { serverUrl: client.serverUrl, credentials: client.credentials, accountType: "caldav", homeUrl: "" },
      ...request,
    });
    if (!account.principalUrl || !account.rootUrl) throw new Error(HOME_URL_NOT_FOUND);

    const responses = await propfind({
      url: account.principalUrl,
      props: { "c:calendar-home-set": {} },
      depth: "0",
      ...request,
    });
    const principal =
      responses.length === 1
        ? responses[0]
        : responses.find((r) => r.href && urlEquals(new URL(r.href, account.rootUrl!).href, account.principalUrl!));
    const href = principal?.ok ? principal.props?.calendarHomeSet?.href : null;
    if (typeof href !== "string" || !href) throw new Error(HOME_URL_NOT_FOUND);
    return { ...account, homeUrl: new URL(href, account.rootUrl).href };
  }

  /**
   * The fetch handed to tsdav: rate limited, retried on 429/5xx/network
   * errors, and every request/response written to the log file.
   */
  private loggingFetch(): typeof fetch {
    const logger = this.options.logger;
    let counter = 0;
    return async (input, init) => {
      const requestId = ++counter;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await this.limiter.acquire();
        const startedAt = Date.now();
        logger.debug("http.request", {
          requestId,
          attempt,
          method,
          url,
          headers: init?.headers,
          body: typeof init?.body === "string" ? truncate(init.body) : undefined,
        });

        let response: Response;
        try {
          response = await fetch(input, init);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn("http.network_error", { requestId, attempt, method, url, error: lastError.message });
          if (attempt < MAX_ATTEMPTS) {
            const delayMs = retryDelayMs(attempt, null);
            this.options.onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, delayMs, url });
            await sleep(delayMs);
            continue;
          }
          throw lastError;
        }

        // Read the body once so it can be logged, then hand tsdav a fresh Response.
        const text = await response.text();
        logger.debug("http.response", {
          requestId,
          attempt,
          method,
          url,
          status: response.status,
          durationMs: Date.now() - startedAt,
          headers: Object.fromEntries(response.headers.entries()),
          body: truncate(text),
        });

        if (response.status >= 400) this.lastFailureStatus = response.status;
        const retriable = response.status >= 400 && isRetriableStatus(response.status, "caldav");
        if (retriable && attempt < MAX_ATTEMPTS) {
          const delayMs = retryDelayMs(attempt, response.headers.get("retry-after"));
          logger.warn("http.retry", { requestId, attempt, status: response.status, delayMs, url });
          this.options.onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, status: response.status, delayMs, url });
          await sleep(delayMs);
          continue;
        }

        return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      throw lastError ?? new Error("CalDAV request failed");
    };
  }

  // ------------------------------------------------------------ calendars

  private async getCalendars(): Promise<DAVCalendar[]> {
    if (this.calendarsCache) return this.calendarsCache;
    const client = await this.getClient();
    this.calendarsCache = await client.fetchCalendars();
    return this.calendarsCache;
  }

  private async findCalendar(calendarId: string): Promise<DAVCalendar> {
    const calendars = await this.getCalendars();
    const wanted = normalizeUrl(calendarId, this.options.credentials.serverUrl);
    const calendar = calendars.find((cal) => normalizeUrl(cal.url, this.options.credentials.serverUrl) === wanted);
    if (!calendar) {
      const known = calendars.map((cal) => `  - ${displayName(cal)}: ${cal.url}`).join("\n");
      throw new Error(`No CalDAV calendar with URL ${calendarId}. Calendars on this account:\n${known || "  (none)"}`);
    }
    return calendar;
  }

  async getCalendar(calendarId: string): Promise<CalendarInfo> {
    const calendar = await this.findCalendar(calendarId);
    return { id: calendar.url, name: displayName(calendar) };
  }

  // ------------------------------------------------------------ listing

  async *listClones(calendarId: string, onProgress?: ListProgress): AsyncGenerator<CloneEvent[]> {
    const client = await this.getClient();
    const calendar = await this.findCalendar(calendarId);

    onProgress?.({ phase: "fetching", page: 0, itemsOnPage: 0, clonesOnPage: 0, ignoredOnPage: 0, totalClones: 0 });
    const listing = await client.calendarQuery({
      url: calendar.url,
      props: { "d:getetag": {} },
      filters: calendarObjectFilters(this.options.timeRange),
      depth: "1",
    });

    const objectUrls = uniq(
      listing
        .map((response: DAVResponse) => response.href ?? "")
        .filter(Boolean)
        .map((href) => (href.startsWith("http") ? href : new URL(href, calendar.url).href))
        .filter((url) => url.includes(".ics"))
    );

    this.options.logger.info("caldav.listing", { calendarUrl: calendar.url, objectCount: objectUrls.length });

    let page = 0;
    let total = 0;
    const chunks = chunk(objectUrls, this.chunkSize);
    if (!chunks.length) {
      onProgress?.({ phase: "done", page: 1, totalPages: 1, itemsOnPage: 0, clonesOnPage: 0, ignoredOnPage: 0, totalClones: 0 });
      return;
    }

    for (const urls of chunks) {
      page++;
      onProgress?.({ phase: "fetching", page, totalPages: chunks.length, itemsOnPage: 0, clonesOnPage: 0, ignoredOnPage: 0, totalClones: total });
      let objects: DAVObject[];
      try {
        objects = await client.fetchCalendarObjects({ calendar, objectUrls: urls });
      } catch (err) {
        throw new IncompleteReadError(
          `CalDAV multiget failed on chunk ${page}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`,
          { calendarUrl: calendar.url, chunk: page, chunks: chunks.length }
        );
      }

      const clones: CloneEvent[] = [];
      for (const object of objects) {
        const parsed = parseCalDavObject({ url: object.url, etag: object.etag, data: object.data });
        if (parsed.parseError) {
          this.options.logger.warn("caldav.parse_error", { url: object.url, error: parsed.parseError });
          this.options.onParseWarning?.(`Could not parse ${object.url}: ${parsed.parseError}`);
          continue;
        }
        if (parsed.isClone) clones.push(calDavToCloneEvent(parsed));
      }
      total += clones.length;
      onProgress?.({
        phase: "done",
        page,
        totalPages: chunks.length,
        itemsOnPage: objects.length,
        clonesOnPage: clones.length,
        ignoredOnPage: objects.length - clones.length,
        totalClones: total,
      });
      if (clones.length) yield clones;
    }
  }

  // ------------------------------------------------------------ deleting

  async deleteClone(_calendarId: string, event: CloneEvent): Promise<DeleteResult> {
    if (!event.url) {
      return { id: event.id, status: "failed", retriable: false, error: "Clone has no object URL" };
    }
    try {
      const client = await this.getClient();
      // Only the URL is sent (no If-Match) so a stale etag cannot block the delete.
      const response = await client.deleteCalendarObject({ calendarObject: { url: event.url } });
      if (response.ok) return { id: event.id, status: "deleted", statusCode: response.status };
      if (ALREADY_GONE.includes(response.status)) {
        return { id: event.id, status: "already_gone", statusCode: response.status };
      }
      const body = (await response.text().catch(() => "")).slice(0, 200);
      return {
        id: event.id,
        status: "failed",
        statusCode: response.status,
        retriable: isRetriableStatus(response.status, "caldav"),
        error: `DELETE ${event.url} failed with ${response.status}${body ? `: ${body}` : ""}`,
      };
    } catch (err) {
      return { id: event.id, status: "failed", retriable: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async batchDeleteClones(calendarId: string, events: CloneEvent[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];
    for (const event of events) results.push(await this.deleteClone(calendarId, event));
    return results;
  }
}

// ---------------------------------------------------------------- helpers

export function normalizeUrl(url: string, base: string): string {
  try {
    const absolute = new URL(url, base);
    return absolute.href.replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function displayName(calendar: DAVCalendar): string {
  const name = calendar.displayName;
  if (typeof name === "string" && name) return name;
  if (name && typeof name === "object" && "_cdata" in name && typeof name._cdata === "string") return name._cdata;
  return "(unnamed)";
}

/** ISO timestamp to the UTC form CalDAV time-range filters expect: 20261029T100000Z */
export function toCalDavUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function calendarObjectFilters(timeRange?: CalDavTimeRange) {
  const vevent: Record<string, unknown> = { _attributes: { name: "VEVENT" } };
  if (timeRange?.start || timeRange?.end) {
    vevent["time-range"] = {
      _attributes: {
        ...(timeRange.start ? { start: toCalDavUtc(timeRange.start) } : {}),
        ...(timeRange.end ? { end: toCalDavUtc(timeRange.end) } : {}),
      },
    };
  }
  return {
    "comp-filter": {
      _attributes: { name: "VCALENDAR" },
      "comp-filter": vevent,
    },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function truncate(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}
