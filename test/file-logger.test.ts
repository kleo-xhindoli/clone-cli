import { describe, expect, it } from "vitest";
import { redact } from "../src/logging/file-logger.js";

describe("redact", () => {
  it("hides tokens and auth headers but keeps everything else", () => {
    const out = redact({
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
      body: { password: "p", nested: { access_token: "x", title: "Busy" } },
      plain: "Bearer inline-token",
    });
    expect(out).toEqual({
      headers: { Authorization: "<redacted>", Accept: "application/json" },
      body: { password: "<redacted>", nested: { access_token: "<redacted>", title: "Busy" } },
      plain: "Bearer <redacted>",
    });
  });
});
