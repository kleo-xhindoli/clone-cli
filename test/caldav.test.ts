import { describe, expect, it } from "vitest";
import { calendarObjectFilters, normalizeUrl, toCalDavUtc } from "../src/providers/caldav.js";

describe("CalDAV helpers", () => {
  it("normalizes calendar URLs so relative and trailing-slash forms match", () => {
    const base = "https://caldav.icloud.com";
    expect(normalizeUrl("/123/calendars/abc/", base)).toBe("https://caldav.icloud.com/123/calendars/abc");
    expect(normalizeUrl("https://caldav.icloud.com/123/calendars/abc", base)).toBe("https://caldav.icloud.com/123/calendars/abc");
  });

  it("formats time-range filters in CalDAV UTC form", () => {
    expect(toCalDavUtc("2026-10-29T10:00:00.000Z")).toBe("20261029T100000Z");
    expect(calendarObjectFilters()).toEqual({
      "comp-filter": { _attributes: { name: "VCALENDAR" }, "comp-filter": { _attributes: { name: "VEVENT" } } },
    });
    const withRange = calendarObjectFilters({ start: "2025-10-29T00:00:00Z", end: "2027-10-29T00:00:00Z" });
    expect(withRange["comp-filter"]["comp-filter"]).toMatchObject({
      "time-range": { _attributes: { start: "20251029T000000Z", end: "20271029T000000Z" } },
    });
  });
});
