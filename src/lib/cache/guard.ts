import type { CacheLogger } from "./types";

export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

export interface RedisGuardOptions {
  /** Upper bound for any single Redis operation. */
  timeoutMs?: number;
  /** After a failure, Redis is not tried again for this long (requests use the fallback instead). */
  cooldownMs?: number;
  now?: () => number;
  log?: CacheLogger;
}

/**
 * Shared failure policy for everything that talks to Redis: every operation gets a hard timeout, and after a
 * failure a short circuit-breaker window routes callers to their in-memory fallback without paying the timeout
 * again. A request therefore never waits on a sick Redis for more than `timeoutMs`, and only once per cooldown.
 */
export class RedisGuard {
  private openUntil = 0;
  private degraded = false;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log?: CacheLogger;

  constructor(options: RedisGuardOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 300;
    this.cooldownMs = options.cooldownMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** True while the breaker is open or the last attempt failed (until a success is observed). */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** True while callers must not even try Redis. */
  get isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  async run<T>(op: () => Promise<T>, timeoutMs: number = this.timeoutMs): Promise<T> {
    if (this.isOpen) throw new RedisUnavailableError("redis circuit open");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RedisUnavailableError("redis operation timed out")), timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([op(), timeout]);
      this.markHealthy();
      return result;
    } catch (err) {
      this.markFailed(err);
      throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError((err as Error)?.message ?? "redis error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Called by the connection layer when the socket is ready again, so recovery does not wait for the cooldown. */
  markHealthy(): void {
    if (this.degraded) this.log?.info("redis: recovered, shared cache and rate limits are active again");
    this.degraded = false;
    this.openUntil = 0;
  }

  markFailed(err: unknown): void {
    if (!this.degraded) {
      this.log?.warn(`redis: unavailable (${(err as Error)?.message ?? "unknown"}), degrading to in-memory until it recovers`);
    }
    this.degraded = true;
    this.openUntil = this.now() + this.cooldownMs;
  }
}
