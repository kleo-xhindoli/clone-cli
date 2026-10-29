import { describe, expect, it } from "vitest";
import { isRetriableStatus, parseRetryAfterMs, retryDelayMs } from "../src/http/retry.js";

describe("retry decisions", () => {
  it("retries 429, 5xx, network errors and Google 403", () => {
    expect(isRetriableStatus(429)).toBe(true);
    expect(isRetriableStatus(503)).toBe(true);
    expect(isRetriableStatus(undefined)).toBe(true);
    expect(isRetriableStatus(403, "google")).toBe(true);
    expect(isRetriableStatus(403, "outlook")).toBe(false);
    expect(isRetriableStatus(409)).toBe(true);
    expect(isRetriableStatus(404)).toBe(false);
    expect(isRetriableStatus(400)).toBe(false);
  });

  it("parses Retry-After in seconds or as a date", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    const now = Date.parse("2026-10-29T10:00:00Z");
    expect(parseRetryAfterMs("Thu, 29 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfterMs("Thu, 29 Oct 2026 09:00:00 GMT", now)).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it("honours a short Retry-After and backs off exponentially otherwise", () => {
    expect(retryDelayMs(1, "2")).toBe(2000);
    expect(retryDelayMs(1, "600")).toBeGreaterThanOrEqual(500);
    expect(retryDelayMs(1, "600")).toBeLessThan(1000);
    expect(retryDelayMs(3, null)).toBeGreaterThanOrEqual(2000);
    expect(retryDelayMs(10, null)).toBeLessThanOrEqual(30_250);
  });
});
