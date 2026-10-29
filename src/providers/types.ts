/**
 * Shared shapes for the three calendar providers.
 *
 * A CloneEvent is the minimum the CLI needs to show a clone to the user and
 * to delete it. `raw` keeps the provider payload for the log file.
 */

export type ProviderName = "google" | "outlook" | "caldav";

export interface CloneEvent {
  /** Provider event id (Google id, Graph id, CalDAV UID). */
  id: string;
  title?: string;
  start?: string;
  end?: string;
  isRecurring?: boolean;
  /** Set on an exception of a recurring clone. Deleting the master removes it too. */
  recurringEventId?: string;
  syncId?: string;
  sourceId?: string;
  /** CalDAV only: the object URL the clone is stored at. */
  url?: string;
  /** Kept small on purpose: big calendars can hold thousands of clones. */
  raw?: { url?: string; etag?: string; uid?: string };
}

export interface CalendarInfo {
  id: string;
  name: string;
}

export type DeleteStatus = "deleted" | "already_gone" | "failed";

export interface DeleteResult {
  id: string;
  status: DeleteStatus;
  statusCode?: number;
  error?: string;
  /** True when the pipeline may re-queue the event (rate limit, 5xx, network). */
  retriable?: boolean;
}

/**
 * Listing reports progress through this callback so the UI can show what is
 * happening while a long read is still running.
 */
export interface ListProgressInfo {
  /** "fetching" is emitted before a page is requested, "done" once it is parsed. */
  phase: "fetching" | "done";
  page: number;
  /** Known total pages, when the provider can tell (CalDAV chunks). */
  totalPages?: number;
  /** Items the provider returned on this page, including ones ignored. */
  itemsOnPage: number;
  clonesOnPage: number;
  /** Items dropped on this page: not a clone, or a cancelled tombstone. */
  ignoredOnPage: number;
  /** Google only: cancelled (already deleted) clone tombstones on this page. */
  cancelledOnPage?: number;
  totalClones: number;
  totalCancelled?: number;
}
export type ListProgress = (info: ListProgressInfo) => void;

export interface CloneProvider {
  readonly name: ProviderName;
  /** Human readable label for the provider ("Google", "Outlook", "CalDAV"). */
  readonly label: string;
  /** Max events per batch call in batch mode. */
  readonly batchSize: number;
  /** Text shown next to the "Batch" option so the user knows what it means. */
  readonly batchHint: string;

  getCalendar(calendarId: string): Promise<CalendarInfo>;
  /** Yields one page (or chunk) of clone events at a time. */
  listClones(calendarId: string, onProgress?: ListProgress): AsyncGenerator<CloneEvent[]>;
  deleteClone(calendarId: string, event: CloneEvent): Promise<DeleteResult>;
  batchDeleteClones(calendarId: string, events: CloneEvent[]): Promise<DeleteResult[]>;
  /** What to ask the user for when a 401 is seen ("access token", "app password"). */
  readonly credentialLabel: string;
  /** Replace the expired credential so the run can continue. */
  updateCredentials(secret: string): void;
}

export class IncompleteReadError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "IncompleteReadError";
  }
}
