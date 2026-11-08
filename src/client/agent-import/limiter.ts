/** Counting semaphore; waiters re-check the limit so it can shrink at runtime. */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(protected limit: number) {}
  get current() {
    return this.limit;
  }
  async run<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
    if (this.active >= this.limit) onWait?.();
    while (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
  protected setLimit(limit: number) {
    this.limit = limit;
    for (let free = limit - this.active; free > 0 && this.waiting.length; free--)
      this.waiting.shift()!();
  }
}

/**
 * Additive-increase / multiplicative-decrease limit for model requests.
 * Upload bandwidth and provider latency are shared by every in-flight request,
 * so timeouts halve the window (at most once per cooldown) and a full window of
 * successes widens it by one.
 */
export class AdaptiveGate extends Gate {
  private streak = 0;
  private shrunkAt = 0;
  constructor(
    private min: number,
    private max: number,
    start: number,
    private cooldownMs = 30000,
  ) {
    super(Math.max(min, Math.min(max, start)));
  }
  success() {
    if (++this.streak >= this.limit && this.limit < this.max) {
      this.streak = 0;
      this.setLimit(this.limit + 1);
    }
  }
  overload(now = Date.now()) {
    this.streak = 0;
    if (now - this.shrunkAt < this.cooldownMs) return;
    this.shrunkAt = now;
    this.setLimit(Math.max(this.min, Math.floor(this.limit / 2)));
  }
}
