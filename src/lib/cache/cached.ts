import type { Cache } from "./types";

/**
 * Read-through helper. The cache is an optimization only: a failing get/set is swallowed and the loader
 * (the real DB read) still produces the answer. `null`/`undefined` results are never cached.
 */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await cache.get<T>(key);
    if (hit !== null) return hit;
  } catch {
    // fall through to the loader
  }
  const value = await load();
  if (value !== null && value !== undefined) {
    try {
      await cache.set(key, value, ttlSeconds);
    } catch {
      // ignore: the next request simply misses again
    }
  }
  return value;
}

/** Invalidation must not turn a successful write into a failed request. */
export async function invalidatePrefix(cache: Cache, prefix: string): Promise<void> {
  try {
    await cache.delByPrefix(prefix);
  } catch {
    // TTL is the backstop
  }
}
