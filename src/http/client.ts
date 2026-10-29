/**
 * Thin fetch wrapper: rate limiting, retries, and full request/response
 * logging to the JSONL file. Both Google and Outlook go through this.
 */
import type { FileLogger } from "../logging/file-logger.js";
import { RateLimiter } from "./rate-limiter.js";
import { MAX_ATTEMPTS, isRetriableStatus, retryDelayMs, sleep } from "./retry.js";

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: T | null;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly response?: HttpResponse,
    public readonly retriable = false
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  provider: "google" | "outlook";
  accessToken: string;
  logger: FileLogger;
  rps?: number;
  /** Called when a request is being retried; the UI shows it so nothing looks stuck. */
  onRetry?: (info: { attempt: number; maxAttempts: number; status?: number; delayMs: number; url: string }) => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Status codes that count as a normal outcome and must not throw. */
  okStatuses?: number[];
  /** Short label for the log file ("list clones page 3"). */
  label?: string;
}

let requestCounter = 0;

export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.limiter = new RateLimiter(options.rps ?? 4);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setAccessToken(token: string): void {
    this.options.accessToken = token;
  }

  async request<T = unknown>(req: RequestOptions): Promise<HttpResponse<T>> {
    const requestId = ++requestCounter;
    const okStatuses = new Set(req.okStatuses ?? []);
    let lastError: HttpError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.limiter.acquire();
      const startedAt = Date.now();
      const headers = {
        Authorization: `Bearer ${this.options.accessToken}`,
        Accept: "application/json",
        ...(req.body && !req.headers?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      };

      this.options.logger.debug("http.request", {
        requestId,
        attempt,
        label: req.label,
        method: req.method,
        url: req.url,
        headers,
        body: truncate(req.body),
      });

      let response: HttpResponse<T>;
      try {
        const res = await this.fetchImpl(req.url, { method: req.method, headers, body: req.body });
        const text = await res.text();
        response = {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          text,
          json: parseJson<T>(text),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger.warn("http.network_error", { requestId, attempt, url: req.url, error: message });
        lastError = new HttpError(`Network error: ${message}`, undefined, undefined, true);
        if (attempt < MAX_ATTEMPTS) {
          const delayMs = retryDelayMs(attempt, null);
          this.options.onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, delayMs, url: req.url });
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      this.options.logger.debug("http.response", {
        requestId,
        attempt,
        label: req.label,
        method: req.method,
        url: req.url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        headers: response.headers,
        body: truncate(response.text),
      });

      if (response.status < 400 || okStatuses.has(response.status)) return response;

      const retriable = isRetriableStatus(response.status, this.options.provider);
      lastError = new HttpError(
        `${req.method} ${req.url} failed with ${response.status}: ${summarizeError(response)}`,
        response.status,
        response,
        retriable
      );

      if (retriable && attempt < MAX_ATTEMPTS) {
        const delayMs = retryDelayMs(attempt, response.headers["retry-after"]);
        this.options.logger.warn("http.retry", {
          requestId,
          attempt,
          status: response.status,
          delayMs,
          url: req.url,
        });
        this.options.onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, status: response.status, delayMs, url: req.url });
        await sleep(delayMs);
        continue;
      }
      throw lastError;
    }

    throw lastError ?? new HttpError("Request failed", undefined);
  }
}

function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function truncate(text: string | undefined, max = 20_000): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

export function summarizeError(response: HttpResponse): string {
  const json = response.json as { error?: { message?: string; code?: string | number } } | null;
  if (json?.error?.message) {
    return json.error.code ? `${json.error.code} ${json.error.message}` : json.error.message;
  }
  return response.text.slice(0, 200) || "(empty body)";
}
