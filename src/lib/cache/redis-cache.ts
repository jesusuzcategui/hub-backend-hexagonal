import { MemoryCache } from "./memory";
import { RedisGuard } from "./guard";
import type { Cache, RedisLike } from "./types";

export interface RedisCacheOptions {
  /** Deployment namespace. Every key written to Redis is `${namespace}:c:${key}`. */
  namespace: string;
  guard: RedisGuard;
  /** Serves reads/writes while Redis is degraded. Defaults to a small private MemoryCache. */
  fallback?: Cache;
}

const MAX_PENDING_INVALIDATIONS = 50;
const SCAN_COUNT = 200;
const SCAN_MAX_ROUNDS = 200;
// A prefix sweep walks the keyspace, so it gets a longer budget than a point command.
const SWEEP_TIMEOUT_MS = 3000;

function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, "\\$&");
}

type Pending = { kind: "key" | "prefix"; value: string };

/**
 * Redis-backed cache that can never take the caller down. Any Redis failure (error, timeout, open breaker)
 * is absorbed: reads and writes are served by the in-memory fallback until Redis answers again.
 *
 * Invalidations that could not reach Redis are remembered and replayed before the next Redis read, so an
 * outage cannot resurrect stale entries that were deleted while it lasted.
 */
export class RedisCache implements Cache {
  private readonly ns: string;
  private readonly guard: RedisGuard;
  private readonly fallback: Cache;
  private pending: Pending[] = [];
  private pendingOverflow = false;
  private replaying: Promise<void> | null = null;

  constructor(private readonly client: RedisLike, options: RedisCacheOptions) {
    this.ns = `${options.namespace}:c:`;
    this.guard = options.guard;
    this.fallback = options.fallback ?? new MemoryCache({ maxEntries: 500 });
  }

  get backend(): "memory" | "redis" {
    return this.guard.isDegraded ? "memory" : "redis";
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      await this.replayPending();
      const raw = await this.guard.run(() => this.client.get(this.ns + key));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null; // corrupt entry: treat as a miss, the next set overwrites it
      }
    } catch {
      return this.fallback.get<T>(key);
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!(ttlSeconds > 0)) return;
    const json = JSON.stringify(value);
    if (json === undefined) return;
    try {
      await this.replayPending();
      await this.guard.run(() => this.client.set(this.ns + key, json, "EX", Math.ceil(ttlSeconds)));
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.fallback.del(key);
    try {
      await this.guard.run(() => this.client.del(this.ns + key));
    } catch {
      this.remember({ kind: "key", value: key });
    }
  }

  async delByPrefix(prefix: string): Promise<void> {
    await this.fallback.delByPrefix(prefix);
    try {
      const complete = await this.guard.run(() => this.scanDelete(prefix), SWEEP_TIMEOUT_MS);
      if (!complete) this.remember({ kind: "prefix", value: prefix }); // cap hit on a huge keyspace: finish later
    } catch {
      this.remember({ kind: "prefix", value: prefix });
    }
  }

  private remember(p: Pending): void {
    if (this.pending.length >= MAX_PENDING_INVALIDATIONS) {
      this.pendingOverflow = true;
      this.pending = [];
      return;
    }
    this.pending.push(p);
  }

  private async replayPending(): Promise<void> {
    if (this.replaying) return this.replaying; // concurrent callers wait for the same replay
    if (this.pending.length === 0 && !this.pendingOverflow) return;
    const todo = this.pending;
    const overflow = this.pendingOverflow;
    this.pending = [];
    this.pendingOverflow = false;
    this.replaying = (async () => {
      try {
        const incomplete: Pending[] = [];
        await this.guard.run(async () => {
          if (overflow) {
            if (!(await this.scanDelete(""))) incomplete.push({ kind: "prefix", value: "" }); // whole namespace, never FLUSH
            return;
          }
          for (const p of todo) {
            if (p.kind === "key") await this.client.del(this.ns + p.value);
            else if (!(await this.scanDelete(p.value))) incomplete.push(p);
          }
        }, SWEEP_TIMEOUT_MS);
        this.pending = incomplete.concat(this.pending);
      } catch (err) {
        // keep what failed AND anything remembered while the replay was running
        this.pending = todo.concat(this.pending);
        this.pendingOverflow = this.pendingOverflow || overflow;
        throw err;
      } finally {
        this.replaying = null;
      }
    })();
    return this.replaying;
  }

  /** Returns false when the round cap was hit before the sweep finished. */
  private async scanDelete(prefix: string): Promise<boolean> {
    const pattern = `${escapeGlob(this.ns + prefix)}*`;
    let cursor = "0";
    for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
      const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
      if (keys.length > 0) await this.client.del(...keys);
      cursor = next;
      if (cursor === "0") return true;
    }
    return false;
  }
}
