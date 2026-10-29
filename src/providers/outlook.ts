/**
 * Microsoft Graph (Outlook) provider. Listing follows mono's getCloneEvents:
 * filter on the io.onecal open extension, expand it, walk every page, drop
 * occurrences, and re-check onecal_createdByOneCal on each item.
 */
import {
  OUTLOOK_EXTENSION_ID,
  isOutlookClone,
  outlookToCloneEvent,
  type OutlookEventLike,
} from "../core/clone-detection.js";
import { HttpClient, summarizeError, type HttpResponse } from "../http/client.js";
import { isRetriableStatus } from "../http/retry.js";
import type { FileLogger } from "../logging/file-logger.js";
import { toFailedResult } from "./google.js";
import {
  IncompleteReadError,
  type CalendarInfo,
  type CloneEvent,
  type CloneProvider,
  type DeleteResult,
  type ListProgress,
} from "./types.js";

// Overridable so the whole CLI can be exercised against a local mock server.
const BASE_URL = process.env.CLONE_CLI_OUTLOOK_BASE_URL || "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const ALREADY_GONE = [404];
const SELECT_FIELDS = "id,subject,type,seriesMasterId,isCancelled,start,end";

interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

interface GraphBatchResponse {
  responses?: Array<{ id: string; status: number; headers?: Record<string, string>; body?: unknown }>;
}

export class OutlookProvider implements CloneProvider {
  readonly name = "outlook" as const;
  readonly label = "Outlook";
  readonly batchSize = 20;
  readonly batchHint = "one Graph $batch request per 20 deletes";
  readonly credentialLabel = "access token";

  private readonly http: HttpClient;

  constructor(options: { accessToken: string; logger: FileLogger; http?: HttpClient; onRetry?: ConstructorParameters<typeof HttpClient>[0]["onRetry"] }) {
    this.http =
      options.http ??
      new HttpClient({ provider: "outlook", accessToken: options.accessToken, logger: options.logger, onRetry: options.onRetry });
  }

  updateCredentials(token: string): void {
    this.http.setAccessToken(token);
  }

  async getCalendar(calendarId: string): Promise<CalendarInfo> {
    const res = await this.http.request<{ id: string; name?: string }>({
      method: "GET",
      url: `${BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}`,
      label: "get calendar",
    });
    return { id: res.json?.id ?? calendarId, name: res.json?.name || "(unnamed)" };
  }

  async *listClones(calendarId: string, onProgress?: ListProgress): AsyncGenerator<CloneEvent[]> {
    const params = new URLSearchParams({
      $expand: `extensions($filter=id eq '${OUTLOOK_EXTENSION_ID}')`,
      $filter: `extensions/any(f:f/id eq '${OUTLOOK_EXTENSION_ID}')`,
      $select: SELECT_FIELDS,
      $top: String(PAGE_SIZE),
    });
    let url: string | undefined = `${BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    let page = 0;
    let total = 0;

    while (url && page < MAX_PAGES) {
      page++;
      onProgress?.({ phase: "fetching", page, itemsOnPage: 0, clonesOnPage: 0, ignoredOnPage: 0, totalClones: total });
      const res: HttpResponse<GraphPage<OutlookEventLike>> = await this.http.request<GraphPage<OutlookEventLike>>({
        method: "GET",
        url,
        label: `list clones page ${page}`,
      });
      const items = res.json?.value ?? [];
      const clones = items.filter(isOutlookClone).map(outlookToCloneEvent);
      total += clones.length;
      url = res.json?.["@odata.nextLink"];
      onProgress?.({
        phase: "done",
        page,
        itemsOnPage: items.length,
        clonesOnPage: clones.length,
        ignoredOnPage: items.length - clones.length,
        totalClones: total,
      });
      if (clones.length) yield clones;
    }

    if (url) {
      throw new IncompleteReadError(`Outlook listing still had pages after ${page} page(s)`, { calendarId, page });
    }
  }

  async deleteClone(calendarId: string, event: CloneEvent): Promise<DeleteResult> {
    try {
      const res = await this.http.request({
        method: "DELETE",
        url: `${BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`,
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
    const requests = events.map((event, index) => ({
      id: String(index + 1),
      method: "DELETE",
      url: `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`,
    }));

    let res: HttpResponse<GraphBatchResponse>;
    try {
      res = await this.http.request<GraphBatchResponse>({
        method: "POST",
        url: `${BASE_URL}/$batch`,
        body: JSON.stringify({ requests }),
        label: `batch delete ${events.length} clones`,
      });
    } catch (err) {
      return events.map((event) => toFailedResult(event.id, err));
    }

    const responses = res.json?.responses ?? [];
    return events.map((event, index) => {
      const part = responses.find((r) => r.id === requests[index].id);
      if (!part) {
        return { id: event.id, status: "failed", retriable: true, error: "No response for this event in the $batch reply" };
      }
      if (part.status < 400) return { id: event.id, status: "deleted", statusCode: part.status };
      if (ALREADY_GONE.includes(part.status)) return { id: event.id, status: "already_gone", statusCode: part.status };
      const text = typeof part.body === "string" ? part.body : JSON.stringify(part.body ?? "");
      return {
        id: event.id,
        status: "failed",
        statusCode: part.status,
        retriable: isRetriableStatus(part.status, "outlook"),
        error: summarizeError({ status: part.status, headers: {}, text, json: typeof part.body === "object" ? part.body : null }),
      };
    });
  }
}
