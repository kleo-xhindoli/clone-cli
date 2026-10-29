/**
 * Retry decisions, copied from mono's generic client: 429, 403 (Google uses it
 * for rate limiting), 5xx and network errors are retried; Retry-After is
 * honoured when it is short, otherwise exponential backoff with jitter.
 */

export const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_SECONDS = 60;

export function isRetriableStatus(status: number | undefined, provider?: string): boolean {
  if (status === undefined) return true; // network error / no response
  if (status === 429 || status >= 500) return true;
  // Google answers 409 Conflict for a whole batch sent while it is still
  // cascading the previous batch's series deletes; Microsoft uses 409 for
  // ConcurrentItemSave. Both clear up on a later attempt.
  if (status === 409) return true;
  if (status === 403 && provider === "google") return true;
  return false;
}

/** Retry-After is seconds or an HTTP date. Returns milliseconds, or null. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (!Number.isNaN(date) && date > now) return date - now;
  return null;
}

export function retryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  const advised = parseRetryAfterMs(retryAfter);
  if (advised !== null && advised <= MAX_RETRY_AFTER_SECONDS * 1000) {
    return advised;
  }
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
