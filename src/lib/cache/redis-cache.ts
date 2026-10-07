import { MemoryCache } from "./memory";
import { RedisGuard } from "./guard";
import type { Cache, RedisLike } from "./types";

export interface RedisCacheOptions {
  /** Deployment namespace. Every key written to Redis starts with `${namespace}:c:`. */
  namespace: string;
  guard: RedisGuard;
  /** Serves reads/writes while Redis is degraded. Defaults to a small private MemoryCache. */
  fallback?: Cache;
  /** How long a group's version is trusted before re-reading it (other instances' bumps show up within this). */
  versionTtlMs?: number;
  /** Delay before a background retry of bumps that could not reach Redis. */
  retryMs?: number;
  now?: () => number;
}

/** "products:slug:x" -> "products"; "payment-methods" -> "payment-methods". */
function groupOf(keyOrPrefix: string): string {
  const i = keyOrPrefix.indexOf(":");
  return i === -1 ? keyOrPrefix : keyOrPrefix.slice(0, i);
}

function restOf(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? "" : key.slice(i + 1);
}

interface Version {
  value: string;
  fetchedAt: number;
}

/**
 * Redis-backed cache that can never take the caller down. Any Redis failure (error, timeout, open breaker) is
 * absorbed: reads and writes are served by the in-memory fallback until Redis answers again.
 *
 * Invalidation is versioned instead of scanning: keys are `${ns}:c:<group>:v<ver>:<rest>` and the version lives
 * in `${ns}:c:ver:<group>`. Invalidating a group is a single INCR; entries of older versions are never read again
 * and simply expire by TTL. Each instance trusts a group's version for `versionTtlMs`, except that its own bumps
 * apply immediately.
 *
 * Bumps that could not reach Redis are queued (a set of group names, so the queue is bounded) and retried in the
 * background and before the next Redis read, so an outage cannot resurrect entries invalidated while it lasted.
 */
export class RedisCache implements Cache {
  private readonly base: string;
  private readonly guard: RedisGuard;
  private readonly fallback: Cache;
  private readonly versionTtlMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly versions = new Map<string, Version>();
  private readonly knownGroups = new Set<string>();
  private pending = new Set<string>();
  private replaying: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: RedisLike, options: RedisCacheOptions) {
    this.base = `${options.namespace}:c:`;
    this.guard = options.guard;
    this.fallback = options.fallback ?? new MemoryCache({ maxEntries: 500 });
    this.versionTtlMs = options.versionTtlMs ?? 1000;
    this.retryMs = options.retryMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  get backend(): "memory" | "redis" {
    return this.guard.isDegraded ? "memory" : "redis";
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const redisKey = await this.redisKey(key);
      const raw = await this.guard.run(() => this.client.get(redisKey));
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
      const redisKey = await this.redisKey(key);
      await this.guard.run(() => this.client.set(redisKey, json, "EX", Math.ceil(ttlSeconds)));
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.fallback.del(key);
    await this.bump(groupOf(key)); // group granularity: exact deletes would need the (possibly stale) version
  }

  async delByPrefix(prefix: string): Promise<void> {
    await this.fallback.delByPrefix(prefix);
    if (prefix === "") {
      await Promise.all([...this.knownGroups].map((g) => this.bump(g)));
      return;
    }
    await this.bump(groupOf(prefix));
  }

  private async redisKey(key: string): Promise<string> {
    const group = groupOf(key);
    this.knownGroups.add(group);
    await this.replayPending(); // never read a group whose invalidation is still waiting to reach Redis
    const version = await this.versionOf(group);
    return `${this.base}${group}:v${version}:${restOf(key)}`;
  }

  private async versionOf(group: string): Promise<string> {
    const cachedVersion = this.versions.get(group);
    if (cachedVersion && this.now() - cachedVersion.fetchedAt < this.versionTtlMs) return cachedVersion.value;
    const raw = await this.guard.run(() => this.client.get(`${this.base}ver:${group}`));
    const value = raw ?? "0";
    this.versions.set(group, { value, fetchedAt: this.now() });
    return value;
  }

  /** One INCR. On failure the bump is queued; either way this never throws. */
  private async bump(group: string): Promise<void> {
    this.knownGroups.add(group);
    try {
      const next = await this.guard.run(() => this.client.incr(`${this.base}ver:${group}`));
      this.versions.set(group, { value: String(next), fetchedAt: this.now() });
    } catch {
      this.versions.delete(group);
      this.pending.add(group);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.pending.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.replayPending().catch(() => this.scheduleRetry());
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /**
   * Replays queued bumps. Concurrent callers share one in-flight attempt, the attempt is a single guarded
   * round trip (bounded by the guard timeout), and a failure merges back into the queue instead of replacing it.
   * Throws when Redis is still unreachable, which makes the caller use its fallback.
   */
  private async replayPending(): Promise<void> {
    if (this.replaying) return this.replaying;
    if (this.pending.size === 0) return;
    const todo = [...this.pending];
    this.pending = new Set();
    this.replaying = (async () => {
      try {
        const results = await this.guard.run(() =>
          Promise.all(todo.map((g) => this.client.incr(`${this.base}ver:${g}`))),
        );
        todo.forEach((g, i) => this.versions.set(g, { value: String(results[i]), fetchedAt: this.now() }));
      } catch (err) {
        for (const g of todo) this.pending.add(g); // merge: keeps anything queued while we were running
        this.scheduleRetry();
        throw err;
      } finally {
        this.replaying = null;
      }
    })();
    return this.replaying;
  }
}
