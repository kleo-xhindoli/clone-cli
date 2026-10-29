import { describe, expect, it } from "vitest";
import {
  OUTLOOK_EXTENSION_ID,
  calDavToCloneEvent,
  googleToCloneEvent,
  isGoogleClone,
  isOutlookClone,
  outlookToCloneEvent,
  parseCalDavObject,
  parseCloneUid,
} from "../src/core/clone-detection.js";

describe("Google clone detection", () => {
  const clone = {
    id: "g1",
    summary: "Busy",
    status: "confirmed",
    start: { dateTime: "2026-10-30T10:00:00Z" },
    end: { dateTime: "2026-10-30T11:00:00Z" },
    extendedProperties: {
      private: {
        onecal_createdByOneCal: "true",
        onecal_sync_id: "sync_1",
        onecal_source_id: "src%40x",
      },
    },
  };

  it("accepts an event with the private marker", () => {
    expect(isGoogleClone(clone)).toBe(true);
    expect(googleToCloneEvent(clone)).toMatchObject({
      id: "g1",
      title: "Busy",
      syncId: "sync_1",
      sourceId: "src%40x",
      isRecurring: false,
    });
  });

  it("rejects cancelled tombstones, missing marker and marker != true", () => {
    expect(isGoogleClone({ ...clone, status: "cancelled" })).toBe(false);
    expect(isGoogleClone({ id: "x", summary: "Real meeting" })).toBe(false);
    expect(
      isGoogleClone({
        id: "x",
        extendedProperties: { private: { onecal_createdByOneCal: "false" } },
      })
    ).toBe(false);
    expect(
      isGoogleClone({
        id: "x",
        extendedProperties: { shared: { onecal_createdByOneCal: "true" } },
      })
    ).toBe(false);
  });
});

describe("Outlook clone detection", () => {
  const clone = {
    id: "o1",
    subject: "Busy",
    type: "singleInstance",
    start: { dateTime: "2026-10-30T10:00:00.0000000", timeZone: "UTC" },
    extensions: [
      { id: OUTLOOK_EXTENSION_ID, onecal_createdByOneCal: "true", onecal_sync_id: "sync_1" },
    ],
  };

  it("accepts an event with the io.onecal extension marker", () => {
    expect(isOutlookClone(clone)).toBe(true);
    expect(outlookToCloneEvent(clone)).toMatchObject({ id: "o1", syncId: "sync_1" });
  });

  it("rejects occurrences, other extensions and missing marker", () => {
    expect(isOutlookClone({ ...clone, type: "occurrence" })).toBe(false);
    expect(
      isOutlookClone({
        id: "o2",
        extensions: [{ id: "Microsoft.OutlookServices.OpenTypeExtension.other", onecal_createdByOneCal: "true" }],
      })
    ).toBe(false);
    expect(isOutlookClone({ id: "o3", subject: "Real" })).toBe(false);
  });
});

const ics = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", body, "END:VCALENDAR"].join("\r\n");

describe("CalDAV clone detection", () => {
  it("accepts a VEVENT with X-ONECAL_CREATEDBYONECAL", () => {
    const parsed = parseCalDavObject({
      url: "https://dav.example.com/cal/abc.ics",
      etag: '"1"',
      data: ics(
        [
          "BEGIN:VEVENT",
          "UID:abc",
          "SUMMARY:Busy",
          "DTSTART:20261030T100000Z",
          "DTEND:20261030T110000Z",
          "X-ONECAL_CREATEDBYONECAL:true",
          "X-ONECAL_SYNC_ID:sync_1",
          "X-ONECAL_SOURCE_ID:src1",
          "END:VEVENT",
        ].join("\r\n")
      ),
    });
    expect(parsed.isClone).toBe(true);
    expect(parsed).toMatchObject({ uid: "abc", syncId: "sync_1", sourceId: "src1", summary: "Busy" });
    expect(calDavToCloneEvent(parsed)).toMatchObject({ id: "abc", url: "https://dav.example.com/cal/abc.ics" });
  });

  it("accepts the underscore-less property variant", () => {
    const parsed = parseCalDavObject({
      url: "u",
      data: ics("BEGIN:VEVENT\r\nUID:def\r\nDTSTART:20261030T100000Z\r\nX-ONECALCREATEDBYONECAL:true\r\nEND:VEVENT"),
    });
    expect(parsed.isClone).toBe(true);
  });

  it("accepts a clone UID when the server dropped X- properties", () => {
    const uid = "oc1.ssync1.isrc_401.n0a1b2c3";
    expect(parseCloneUid(uid)).toEqual({ syncId: "sync1", sourceEventId: "src@1", sourceEtag: undefined });
    const parsed = parseCalDavObject({
      url: "u",
      data: ics(`BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20261030T100000Z\r\nEND:VEVENT`),
    });
    expect(parsed.isClone).toBe(true);
    expect(parsed.syncId).toBe("sync1");
  });

  it("rejects ordinary events and unparseable data", () => {
    const real = parseCalDavObject({
      url: "u",
      data: ics("BEGIN:VEVENT\r\nUID:team_standup@example.com\r\nSUMMARY:Standup\r\nDTSTART:20261030T100000Z\r\nEND:VEVENT"),
    });
    expect(real.isClone).toBe(false);
    expect(parseCloneUid("team_standup@example.com")).toBeNull();
    expect(parseCloneUid("oc1.garbage")).toBeNull();

    const broken = parseCalDavObject({ url: "u", data: "not ics" });
    expect(broken.isClone).toBe(false);
    expect(broken.parseError).toBeTruthy();
  });

  it("detects recurring clones with exceptions and uses the master VEVENT", () => {
    const parsed = parseCalDavObject({
      url: "u",
      data: ics(
        [
          "BEGIN:VEVENT",
          "UID:rec",
          "RECURRENCE-ID:20261106T100000Z",
          "SUMMARY:Busy (moved)",
          "DTSTART:20261106T120000Z",
          "X-ONECAL_CREATEDBYONECAL:true",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:rec",
          "SUMMARY:Busy",
          "DTSTART:20261030T100000Z",
          "RRULE:FREQ=WEEKLY",
          "X-ONECAL_CREATEDBYONECAL:true",
          "END:VEVENT",
        ].join("\r\n")
      ),
    });
    expect(parsed.isClone).toBe(true);
    expect(parsed.summary).toBe("Busy");
    expect(parsed.isRecurring).toBe(true);
  });
});
