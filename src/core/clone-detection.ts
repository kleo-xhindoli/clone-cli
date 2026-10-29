/**
 * Clone detection, kept identical to mono/apps/sync-service so this tool only
 * ever touches events the sync service itself created.
 *
 * Google:  extendedProperties.private.onecal_createdByOneCal === "true"
 * Outlook: open extension "Microsoft.OutlookServices.OpenTypeExtension.io.onecal"
 *          with onecal_createdByOneCal === "true"
 * CalDAV:  X-ONECAL_CREATEDBYONECAL (or the underscore-less variant some servers
 *          produce), or a UID in the "oc1." clone format used for servers that
 *          drop X- properties (Zoho).
 */
import ICAL from "ical.js";
import type { CloneEvent } from "../providers/types.js";

export const ONECAL_CREATED_BY_PROP = "onecal_createdByOneCal";
export const ONECAL_SYNC_ID_PROP = "onecal_sync_id";
export const ONECAL_SOURCE_ID_PROP = "onecal_source_id";

export const OUTLOOK_EXTENSION_NAME = "io.onecal";
export const OUTLOOK_EXTENSION_ID = `Microsoft.OutlookServices.OpenTypeExtension.${OUTLOOK_EXTENSION_NAME}`;

// ---------------------------------------------------------------- Google

export interface GoogleEventLike {
  id?: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  recurrence?: string[];
  recurringEventId?: string;
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
}

/**
 * A cancelled Google event is a tombstone for an event that was already
 * deleted. Google still returns them (often hundreds or thousands of them) when
 * filtering by extended property, so they must never be counted as clones or
 * kept in memory.
 */
export function isGoogleCancelled(event: GoogleEventLike): boolean {
  return event.status === "cancelled";
}

export function isGoogleClone(event: GoogleEventLike): boolean {
  if (!event.id) return false;
  if (isGoogleCancelled(event)) return false;
  return event.extendedProperties?.private?.[ONECAL_CREATED_BY_PROP] === "true";
}

export function googleToCloneEvent(event: GoogleEventLike): CloneEvent {
  const priv = event.extendedProperties?.private ?? {};
  return {
    id: event.id!,
    title: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    isRecurring: Boolean(event.recurrence?.length),
    recurringEventId: event.recurringEventId,
    syncId: priv[ONECAL_SYNC_ID_PROP],
    sourceId: priv[ONECAL_SOURCE_ID_PROP],
  };
}

// ---------------------------------------------------------------- Outlook

export interface OutlookEventLike {
  id?: string;
  subject?: string;
  type?: string;
  seriesMasterId?: string;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  extensions?: Array<{ id?: string } & Record<string, unknown>>;
}

export function getOutlookOneCalExtension(
  event: OutlookEventLike
): Record<string, unknown> | undefined {
  return event.extensions?.find((ext) => ext.id === OUTLOOK_EXTENSION_ID);
}

export function isOutlookClone(event: OutlookEventLike): boolean {
  if (!event.id) return false;
  // Occurrences are virtual: deleting the master removes them.
  if (event.type === "occurrence") return false;
  const ext = getOutlookOneCalExtension(event);
  return ext?.[ONECAL_CREATED_BY_PROP] === "true";
}

export function outlookToCloneEvent(event: OutlookEventLike): CloneEvent {
  const ext = getOutlookOneCalExtension(event) ?? {};
  return {
    id: event.id!,
    title: event.subject,
    start: event.start?.dateTime,
    end: event.end?.dateTime,
    isRecurring: event.type === "seriesMaster",
    recurringEventId: event.type === "exception" ? event.seriesMasterId : undefined,
    syncId: typeof ext[ONECAL_SYNC_ID_PROP] === "string" ? (ext[ONECAL_SYNC_ID_PROP] as string) : undefined,
    sourceId: typeof ext[ONECAL_SOURCE_ID_PROP] === "string" ? (ext[ONECAL_SOURCE_ID_PROP] as string) : undefined,
  };
}

// ---------------------------------------------------------------- CalDAV

const CALDAV_IDENTIFIER_PROPS = ["x-onecal_createdbyonecal", "x-onecalcreatedbyonecal"];
const CALDAV_SYNC_ID_PROPS = ["x-onecal_sync_id", "x-onecalsyncid"];
const CALDAV_SOURCE_ID_PROPS = ["x-onecal_source_id", "x-onecalsourceid"];

const CLONE_UID_PREFIX = "oc1";
const CLONE_UID_ENCODED_VALUE = /^(?:[A-Za-z0-9-]|_[0-9A-F]{2})+$/;

export interface CloneUidMetadata {
  syncId: string;
  sourceEventId?: string;
  sourceEtag?: string;
}

/** Mirrors mono/apps/sync-service/src/calendar-providers/caldav/clone-uid.ts */
export function parseCloneUid(uid: string | null | undefined): CloneUidMetadata | null {
  if (!uid) return null;
  const [prefix, ...segments] = uid.split(".");
  if (prefix !== CLONE_UID_PREFIX) return null;

  const fields: Record<string, string> = {};
  for (const segment of segments) {
    const encoded = segment.slice(1);
    if (!segment[0] || !CLONE_UID_ENCODED_VALUE.test(encoded)) return null;
    try {
      fields[segment[0]] = decodeURIComponent(encoded.replace(/_/g, "%"));
    } catch {
      return null;
    }
  }
  if (!fields.s || !fields.n) return null;
  return { syncId: fields.s, sourceEventId: fields.i, sourceEtag: fields.e };
}

export interface CalDavObjectLike {
  url: string;
  etag?: string;
  data?: string;
}

export interface ParsedCalDavObject {
  url: string;
  etag?: string;
  uid?: string;
  isClone: boolean;
  summary?: string;
  start?: string;
  end?: string;
  isRecurring: boolean;
  syncId?: string;
  sourceId?: string;
  parseError?: string;
}

function firstStringProp(component: ICAL.Component, names: string[]): string | undefined {
  for (const name of names) {
    const value = component.getFirstPropertyValue(name);
    if (typeof value === "string" && value.length) return value;
  }
  return undefined;
}

/**
 * Parses one CalDAV object (an .ics file) and decides whether it is a clone.
 * An object is a clone when any VEVENT in it carries the OneCal marker, or
 * when its UID is in the clone UID format.
 */
export function parseCalDavObject(object: CalDavObjectLike): ParsedCalDavObject {
  const base: ParsedCalDavObject = {
    url: object.url,
    etag: object.etag,
    isClone: false,
    isRecurring: false,
  };
  if (!object.data) return { ...base, parseError: "empty calendar-data" };

  let vcalendar: ICAL.Component;
  try {
    vcalendar = new ICAL.Component(ICAL.parse(object.data));
  } catch (err) {
    return { ...base, parseError: err instanceof Error ? err.message : String(err) };
  }

  const vevents = vcalendar.getAllSubcomponents("vevent");
  if (!vevents.length) return base;

  // The master VEVENT has no RECURRENCE-ID; fall back to the first one.
  const master =
    vevents.find((v: ICAL.Component) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  const uid = firstStringProp(master, ["uid"]);

  let isClone = false;
  let syncId: string | undefined;
  let sourceId: string | undefined;

  for (const vevent of vevents) {
    const marker = firstStringProp(vevent, CALDAV_IDENTIFIER_PROPS);
    if (marker && marker.toLowerCase() === "true") {
      isClone = true;
      syncId ??= firstStringProp(vevent, CALDAV_SYNC_ID_PROPS);
      sourceId ??= firstStringProp(vevent, CALDAV_SOURCE_ID_PROPS);
    }
  }

  if (!isClone) {
    const meta = parseCloneUid(uid);
    if (meta) {
      isClone = true;
      syncId = meta.syncId;
      sourceId = meta.sourceEventId;
    }
  }

  const dtstart = master.getFirstPropertyValue("dtstart");
  const dtend = master.getFirstPropertyValue("dtend");

  return {
    ...base,
    uid,
    isClone,
    summary: firstStringProp(master, ["summary"]),
    start: dtstart ? String(dtstart) : undefined,
    end: dtend ? String(dtend) : undefined,
    isRecurring: master.hasProperty("rrule"),
    syncId,
    sourceId,
  };
}

export function calDavToCloneEvent(parsed: ParsedCalDavObject): CloneEvent {
  return {
    id: parsed.uid ?? parsed.url,
    title: parsed.summary,
    start: parsed.start,
    end: parsed.end,
    isRecurring: parsed.isRecurring,
    syncId: parsed.syncId,
    sourceId: parsed.sourceId,
    url: parsed.url,
    raw: { url: parsed.url, etag: parsed.etag, uid: parsed.uid },
  };
}
