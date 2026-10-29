/**
 * Google Calendar provider. Listing follows mono's getCloneEvents: filter on
 * the private extended property server-side, walk every page (Google applies
 * the filter after paging, so most pages are empty), drop cancelled
 * tombstones, and re-check the marker on each item before it is ever deleted.
 */
import { googleToCloneEvent, isGoogleCancelled, isGoogleClone, type GoogleEventLike } from "../core/clone-detection.js";
import { HttpClient, HttpError, summarizeError, type HttpResponse } from "../http/client.js";
import { isRetriableStatus } from "../http/retry.js";
import type { FileLogger } from "../logging/file-logger.js";
import {
  GOOGLE_BATCH_BOUNDARY,
  GOOGLE_BATCH_URL,
  boundaryFromContentType,
  buildGoogleBatchBody,
  parseGoogleBatchResponse,
} from "./google-batch.js";
import {
  IncompleteReadError,
  type CalendarInfo,
  type CloneEvent,
  type CloneProvider,
  type DeleteResult,
  type ListProgress,
} from "./types.js";

// Overridable so the whole CLI can be exercised against a local mock server.
const BASE_URL = process.env.CLONE_CLI_GOOGLE_BASE_URL || "https://www.googleapis.com/calendar/v3";
const BATCH_URL = process.env.CLONE_CLI_GOOGLE_BATCH_URL || GOOGLE_BATCH_URL;
const PAGE_SIZE = 2500;
const MAX_PAGES = 250;
const ALREADY_GONE = [404, 410];

interface GoogleEventsPage {
  items?: GoogleEventLike[];
  nextPageToken?: string;
}

export class GoogleProvider implements CloneProvider {
  readonly name = "google" as const;
  readonly label = "Google";
  readonly batchSize = 50;
  readonly batchHint = "one multipart batch request per 50 deletes";
  readonly credentialLabel = "access token";

  private readonly http: HttpClient;

  constructor(private readonly options: { accessToken: string; logger: FileLogger; http?: HttpClient; onRetry?: ConstructorParameters<typeof HttpClient>[0]["onRetry"] }) {
    this.http =
      options.http ??
      new HttpClient({ provider: "google", accessToken: options.accessToken, logger: options.logger, onRetry: options.onRetry });
  }

  updateCredentials(token: string): void {
    this.http.setAccessToken(token);
  }

  async getCalendar(calendarId: string): Promise<CalendarInfo> {
    const encoded = encodeURIComponent(calendarId);
    // calendarList has the user's display name; fall back to the calendar
    // resource for calendars not in the user's list.
    const listRes = await this.http.request<{ id: string; summary?: string; summaryOverride?: string }>({
      method: "GET",
      url: `${BASE_URL}/users/me/calendarList/${encoded}`,
      okStatuses: [404],
      label: "get calendar (calendarList)",
    });
    if (listRes.status === 200 && listRes.json) {
      return { id: listRes.json.id ?? calendarId, name: listRes.json.summaryOverride || listRes.json.summary || "(unnamed)" };
    }
    const calRes = await this.http.request<{ id: string; summary?: string }>({
      method: "GET",
      url: `${BASE_URL}/calendars/${encoded}`,
      label: "get calendar (calendars)",
    });
    return { id: calRes.json?.id ?? calendarId, name: calRes.json?.summary || "(unnamed)" };
  }

  async *listClones(calendarId: string, onProgress?: ListProgress): AsyncGenerator<CloneEvent[]> {
    const params = new URLSearchParams({
      maxResults: String(PAGE_SIZE),
      privateExtendedProperty: "onecal_createdByOneCal=true",
      // Cancelled events are tombstones of clones that were already deleted.
      // Ask Google to leave them out, and drop any that still come through.
      showDeleted: "false",
    });
    let page = 0;
    let total = 0;
    let totalCancelled = 0;
    let pageToken: string | undefined;

    do {
      if (pageToken) params.set("pageToken", pageToken);
      page++;
      onProgress?.({ phase: "fetching", page, itemsOnPage: 0, clonesOnPage: 0, ignoredOnPage: 0, totalClones: total, totalCancelled });
      const res = await this.http.request<GoogleEventsPage>({
        method: "GET",
        url: `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        label: `list clones page ${page}`,
      });
      const items = res.json?.items ?? [];
      // Only the slim CloneEvent survives this loop; the page payload (which
      // can be 2500 items, mostly tombstones) is released before the next read.
      let cancelledOnPage = 0;
      const clones: CloneEvent[] = [];
      for (const item of items) {
        if (isGoogleCancelled(item)) {
          cancelledOnPage++;
          continue;
        }
        if (isGoogleClone(item)) clones.push(googleToCloneEvent(item));
      }
      total += clones.length;
      totalCancelled += cancelledOnPage;
      pageToken = res.json?.nextPageToken;
      this.options.logger.info("google.page", {
        page,
        itemsOnPage: items.length,
        clonesOnPage: clones.length,
        cancelledOnPage,
        hasNextPage: Boolean(pageToken),
      });
      onProgress?.({
        phase: "done",
        page,
        itemsOnPage: items.length,
        clonesOnPage: clones.length,
        ignoredOnPage: items.length - clones.length,
        cancelledOnPage,
        totalClones: total,
        totalCancelled,
      });
      if (clones.length) yield clones;
    } while (pageToken && page < MAX_PAGES);

    if (pageToken) {
      throw new IncompleteReadError(`Google listing still had pages after ${page} page(s)`, { calendarId, page });
    }
  }

  async deleteClone(calendarId: string, event: CloneEvent): Promise<DeleteResult> {
    try {
      const res = await this.http.request({
        method: "DELETE",
        url: `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`,
        okStatuses: ALREADY_GONE,
        label: `delete clone ${event.id}`,
      });
      if (ALREADY_GONE.includes(res.status)) {
        return { id: event.id, status: "already_gone", statusCode: res.status };
      }
      return { id: event.id, status: "deleted", statusCode: res.status };
    } catch (err) {
      return toFailedResult(event.id, err);
    }
  }

  async batchDeleteClones(calendarId: string, events: CloneEvent[]): Promise<DeleteResult[]> {
    if (!events.length) return [];
    const parts = events.map((event, index) => ({
      id: `del-${index}-${sanitizeId(event.id)}`,
      method: "DELETE" as const,
      path: `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`,
    }));

    let res: HttpResponse;
    try {
      res = await this.http.request({
        method: "POST",
        url: BATCH_URL,
        headers: { "Content-Type": `multipart/mixed; boundary=${GOOGLE_BATCH_BOUNDARY}` },
        body: buildGoogleBatchBody(parts),
        label: `batch delete ${events.length} clones`,
      });
    } catch (err) {
      // Whole batch failed: every event gets the same outcome.
      return events.map((event) => toFailedResult(event.id, err));
    }

    const boundary = boundaryFromContentType(res.headers["content-type"]);
    if (!boundary) {
      return events.map((event) => ({ id: event.id, status: "failed", retriable: true, error: "Batch response had no multipart boundary" }));
    }

    let partResponses;
    try {
      partResponses = parseGoogleBatchResponse(res.text, boundary);
    } catch (err) {
      return events.map((event) => ({ id: event.id, status: "failed", retriable: false, error: err instanceof Error ? err.message : String(err) }));
    }

    return events.map((event, index) => {
      const part = partResponses.find((p) => p.id === parts[index].id);
      if (!part) {
        return { id: event.id, status: "failed", retriable: true, error: "No response part for this event in the batch" };
      }
      if (part.status < 400) return { id: event.id, status: "deleted", statusCode: part.status };
      if (ALREADY_GONE.includes(part.status)) return { id: event.id, status: "already_gone", statusCode: part.status };
      return {
        id: event.id,
        status: "failed",
        statusCode: part.status,
        retriable: isRetriableStatus(part.status, "google"),
        error: summarizeError({ status: part.status, headers: {}, text: part.body, json: safeJson(part.body) }),
      };
    });
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toFailedResult(id: string, err: unknown): DeleteResult {
  if (err instanceof HttpError) {
    return { id, status: "failed", statusCode: err.status, retriable: err.retriable, error: err.message };
  }
  return { id, status: "failed", retriable: false, error: err instanceof Error ? err.message : String(err) };
}
