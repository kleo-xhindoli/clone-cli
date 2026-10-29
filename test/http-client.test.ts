import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../src/http/client.js";
import { NullLogger } from "../src/logging/file-logger.js";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("HttpClient", () => {
  it("adds the bearer token and returns parsed JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return jsonResponse(200, { ok: 1 });
    });
    const client = new HttpClient({ provider: "google", accessToken: "tok", logger: new NullLogger(), rps: 1000, fetchImpl: fetchImpl as typeof fetch });
    const res = await client.request<{ ok: number }>({ method: "GET", url: "https://x/y" });
    expect(res.json).toEqual({ ok: 1 });
  });

  it("retries a 429 then succeeds, and reports the retry", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "0" }) : jsonResponse(200, {});
    });
    const onRetry = vi.fn();
    const client = new HttpClient({ provider: "outlook", accessToken: "t", logger: new NullLogger(), rps: 1000, fetchImpl: fetchImpl as typeof fetch, onRetry });
    const res = await client.request({ method: "DELETE", url: "https://x/y" });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not retry a 404 unless listed as ok", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: { message: "gone" } }));
    const client = new HttpClient({ provider: "google", accessToken: "t", logger: new NullLogger(), rps: 1000, fetchImpl: fetchImpl as typeof fetch });
    await expect(client.request({ method: "DELETE", url: "https://x/y" })).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const res = await client.request({ method: "DELETE", url: "https://x/y", okStatuses: [404] });
    expect(res.status).toBe(404);
  });
});
