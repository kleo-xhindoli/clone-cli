import { describe, expect, it } from "vitest";
import { boundaryFromContentType, buildGoogleBatchBody, parseGoogleBatchResponse } from "../src/providers/google-batch.js";

describe("Google batch codec", () => {
  it("builds a multipart/mixed body with one application/http part per request", () => {
    const body = buildGoogleBatchBody(
      [
        { id: "a", method: "DELETE", path: "calendars/primary/events/e1" },
        { id: "b", method: "DELETE", path: "calendars/primary/events/e2" },
      ],
      "B"
    );
    expect(body).toContain("--B\r\nContent-Type: application/http\r\nContent-ID: <a>\r\n\r\nDELETE /calendar/v3/calendars/primary/events/e1\r\n");
    expect(body).toContain("Content-ID: <b>");
    expect(body.endsWith("--B--\r\n")).toBe(true);
  });

  it("extracts the boundary from the response content type", () => {
    expect(boundaryFromContentType('multipart/mixed; boundary="batch_abc"')).toBe("batch_abc");
    expect(boundaryFromContentType("multipart/mixed; boundary=batch_abc")).toBe("batch_abc");
    expect(boundaryFromContentType("application/json")).toBeNull();
  });

  it("parses per-part statuses including 204, 404 and 410", () => {
    const text = [
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-a>",
      "",
      "HTTP/1.1 204 No Content",
      "ETag: \"1\"",
      "",
      "",
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-b>",
      "",
      "HTTP/1.1 410 Gone",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"error":{"code":410,"message":"Resource has been deleted"}}',
      "",
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-c>",
      "",
      "HTTP/1.1 403 Forbidden",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"error":{"code":403,"message":"Rate Limit Exceeded"}}',
      "--batch_x--",
    ].join("\r\n");

    const parts = parseGoogleBatchResponse(text, "batch_x");
    expect(parts).toEqual([
      { id: "a", status: 204, body: "" },
      { id: "b", status: 410, body: '{"error":{"code":410,"message":"Resource has been deleted"}}' },
      { id: "c", status: 403, body: '{"error":{"code":403,"message":"Rate Limit Exceeded"}}' },
    ]);
  });
});
