/** Minimal requests-per-second limiter so the tool behaves like mono's "low" RPS config. */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlot = 0;

  constructor(rps: number) {
    this.intervalMs = 1000 / rps;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
