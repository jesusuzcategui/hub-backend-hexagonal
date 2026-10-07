import type { RateLimitPluginOptions } from "@fastify/rate-limit";
import type { RedisGuard } from "./guard";
import type { CacheLogger, RedisLike } from "./types";

/**
 * Shared rate-limit store for @fastify/rate-limit (its `store` option), fixed-window counters like the
 * default in-memory store. With Redis the counters are shared across instances; while Redis is degraded the
 * store counts in memory per process, i.e. exactly today's behavior, so limits never silently disappear and a
 * Redis outage never turns into a 500.
 *
 * Not supported (unused in this repo): the plugin's continueExceeding / exponentialBackoff / ban options.
 */

// Atomic INCR + expiry. If a key ever lacks a TTL (e.g. a crash between commands elsewhere) it is repaired
// here, so a counter can never become permanent.
const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

type Cb = (err: Error | null, res?: { current: number; ttl: number }) => void;

interface Counter {
  current: number;
  startedAt: number;
}

export interface RateLimitStoreDeps {
  client: RedisLike | null;
  guard: RedisGuard | null;
  namespace: string;
  /** Separates registrations: without it every @fastify/rate-limit registration would share one counter per IP. */
  scope?: string;
  /** Receives a throttled warning when a scope has to count per process because Redis is unavailable. */
  log?: Pick<CacheLogger, "warn">;
  maxLocalKeys?: number;
  now?: () => number;
}

export interface RateLimitStoreInstance {
  incr(key: string, cb: Cb, timeWindow: number, max?: number): void;
  read(key: string, cb: Cb, timeWindow: number, max?: number): void;
  child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }): RateLimitStoreInstance;
}

export type RateLimitStoreClass = NonNullable<RateLimitPluginOptions["store"]>;

export function createRateLimitStore(deps: RateLimitStoreDeps): RateLimitStoreClass {
  const now = deps.now ?? Date.now;
  const maxLocalKeys = deps.maxLocalKeys ?? 5000;
  const WARN_EVERY_MS = 30_000;
  let lastWarn = Number.NEGATIVE_INFINITY;
  const warnLocal = () => {
    const t = now();
    if (t - lastWarn < WARN_EVERY_MS) return;
    lastWarn = t;
    deps.log?.warn(`rate-limit[${deps.scope ?? "default"}]: redis unavailable, counting per process (limits are per instance until it recovers)`);
  };

  class Store implements RateLimitStoreInstance {
    private readonly local = new Map<string, Counter>();

    constructor(_params?: unknown, private readonly keyPrefix = `${deps.namespace}:rl:${deps.scope ? deps.scope + ":" : ""}`) {}

    incr(key: string, cb: Cb, timeWindow: number): void {
      void this.doIncr(key, timeWindow).then(
        (res) => cb(null, res),
        (err) => cb(err as Error),
      );
    }

    read(key: string, cb: Cb, timeWindow: number): void {
      void this.doRead(key, timeWindow).then(
        (res) => cb(null, res),
        (err) => cb(err as Error),
      );
    }

    child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }): RateLimitStoreInstance {
      const info = routeOptions.routeInfo;
      const method = Array.isArray(info?.method) ? info?.method.join(",") : (info?.method ?? "");
      return new Store(undefined, `${this.keyPrefix}${method}${info?.url ?? ""}-`);
    }

    private async doIncr(key: string, timeWindow: number): Promise<{ current: number; ttl: number }> {
      const { client, guard } = deps;
      if (client && guard) {
        try {
          const res = (await guard.run(() => client.eval(INCR_SCRIPT, 1, this.keyPrefix + key, timeWindow))) as [number, number];
          return { current: Number(res[0]), ttl: Number(res[1]) };
        } catch {
          warnLocal();
        }
      }
      return this.localIncr(key, timeWindow);
    }

    private async doRead(key: string, timeWindow: number): Promise<{ current: number; ttl: number }> {
      const { client, guard } = deps;
      if (client && guard) {
        try {
          const raw = await guard.run(() => client.get(this.keyPrefix + key));
          // TTL is not needed for a peek; report a full window when a counter exists.
          return raw === null ? { current: 0, ttl: 0 } : { current: Number(raw) || 0, ttl: timeWindow };
        } catch {
          // fall through
        }
      }
      const c = this.local.get(key);
      if (!c || c.startedAt + timeWindow <= now()) return { current: 0, ttl: 0 };
      return { current: c.current, ttl: timeWindow - (now() - c.startedAt) };
    }

    /** @internal exposed for tests */
    localIncr(key: string, timeWindow: number): { current: number; ttl: number } {
      const t = now();
      let c = this.local.get(key);
      if (!c || c.startedAt + timeWindow <= t) {
        this.local.delete(key);
        if (this.local.size >= maxLocalKeys) this.evict(t, timeWindow);
        c = { current: 1, startedAt: t };
      } else {
        c.current += 1;
      }
      this.local.set(key, c);
      return { current: c.current, ttl: timeWindow - (t - c.startedAt) };
    }

    private evict(t: number, timeWindow: number): void {
      for (const [k, c] of this.local) {
        if (c.startedAt + timeWindow <= t) this.local.delete(k);
      }
      for (const k of this.local.keys()) {
        if (this.local.size < maxLocalKeys) break;
        this.local.delete(k);
      }
    }
  }

  return Store as unknown as RateLimitStoreClass;
}
