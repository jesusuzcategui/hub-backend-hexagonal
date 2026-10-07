import type { FastifyInstance } from "fastify";
import { noopCache } from "./noop";
import type { Cache } from "./types";
import type { RateLimitStoreClass } from "./rate-limit-store";

export type { Cache, RedisLike, CacheLogger } from "./types";
export { MemoryCache } from "./memory";
export { RedisCache } from "./redis-cache";
export { RedisGuard, RedisUnavailableError } from "./guard";
export { noopCache } from "./noop";
export { cached, invalidatePrefix } from "./cached";
export { createRateLimitStore } from "./rate-limit-store";
export type { RateLimitStoreClass } from "./rate-limit-store";

export type RedisState = "disabled" | "connected" | "degraded";

export interface CacheInfo {
  redis: RedisState;
  cache: "off" | "memory" | "redis";
}

/**
 * Caching is a feature flag, consistent with REMINDERS_ENABLED and friends:
 *   - always off under NODE_ENV=test (tests inject a cache explicitly)
 *   - CACHE_ENABLED=false turns it off, even with Redis
 *   - CACHE_ENABLED=true turns it on (in-memory cache when there is no Redis)
 *   - unset: on exactly when Redis is configured
 */
export function cacheEnabled(
  vars: { NODE_ENV?: string; CACHE_ENABLED?: string },
  redisConfigured: boolean,
): boolean {
  if (vars.NODE_ENV === "test") return false;
  const flag = vars.CACHE_ENABLED?.trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return redisConfigured;
}

/** The app cache, or a pass-through when the redis/cache plugin is not registered (unit tests, scripts). */
export function getCache(fastify: FastifyInstance): Cache {
  // Plain property read (not hasDecorator) so partial fakes in unit tests degrade to pass-through too.
  return fastify.cache ?? noopCache;
}

/** Options to spread into `register(rateLimit, {...})`: the shared store when available, else the default. */
export function rateLimitStoreOptions(fastify: FastifyInstance, scope: string): { store?: RateLimitStoreClass } {
  return fastify.rateLimitStore ? { store: fastify.rateLimitStore(scope) } : {};
}

/** Cache key namespaces used by the app. Keep invalidation prefixes next to the keys they cover. */
export const CacheKeys = {
  productsPrefix: "products:",
  productsList: "products:list",
  productBySlug: (slug: string) => `products:slug:${slug}`,
  paymentMethods: "payment-methods",
} as const;

export const CacheTtl = {
  products: 120,
  paymentMethods: 60,
} as const;
