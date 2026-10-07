import fp from "fastify-plugin";
import Redis from "ioredis";
import { FastifyInstance } from "fastify";
import { env } from "../config/env";
import {
  Cache,
  CacheInfo,
  MemoryCache,
  RedisCache,
  RedisGuard,
  RedisLike,
  cacheEnabled,
  createRateLimitStore,
  noopCache,
  type RateLimitStoreClass,
} from "../lib/cache";

declare module "fastify" {
  interface FastifyInstance {
    /** null when REDIS_URL is not configured. Never use it directly for anything that must work without Redis. */
    redis: Redis | null;
    cache: Cache;
    /** Store class for @fastify/rate-limit; undefined means "use the plugin's default in-memory store". */
    rateLimitStore: ((scope: string) => RateLimitStoreClass) | undefined;
    cacheInfo: () => CacheInfo;
  }
}

export interface RedisPluginOptions {
  /** Test seam: use this client instead of connecting to env.cache.url. */
  client?: RedisLike | null;
  /** Test seam: bypass the NODE_ENV/CACHE_ENABLED flag. */
  cacheEnabled?: boolean;
  /** Test seam: milliseconds to wait for the first connection at boot. */
  bootWaitMs?: number;
}

const BOOT_WAIT_MS = 2000;

function connect(url: string, guard: RedisGuard, log: FastifyInstance["log"]): Redis {
  const client = new Redis(url, {
    // Fail fast instead of queueing commands behind a dead socket: a request must never hang on Redis.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 2000,
    // Reconnect forever in the background, backing off to 10 s.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  let lastLogged = 0;
  // Without a listener ioredis would emit an unhandled 'error' event and crash the process.
  client.on("error", (err) => {
    const t = Date.now();
    if (t - lastLogged > 30_000) {
      lastLogged = t;
      log.warn(`redis: connection error (${err.message || (err as NodeJS.ErrnoException).code || err.name}); retrying in the background`);
    }
  });
  client.on("ready", () => guard.markHealthy());
  return client;
}

function waitForReady(client: Redis, ms: number): Promise<boolean> {
  if (client.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), ms);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    client.on("ready", onReady);
  });
}

async function redisPlugin(fastify: FastifyInstance, opts: RedisPluginOptions = {}): Promise<void> {
  const url = env.cache.url;
  const injected = opts.client !== undefined;

  const guard = new RedisGuard({ log: fastify.log });
  let ioredis: Redis | null = null;
  let client: RedisLike | null = null;

  if (injected) {
    client = opts.client ?? null;
  } else if (url) {
    ioredis = connect(url, guard, fastify.log);
    client = ioredis;
  }

  const cacheOn = opts.cacheEnabled ?? cacheEnabled(process.env, client !== null);
  const namespace = env.cache.prefix;

  let cache: Cache = noopCache;
  if (cacheOn) {
    cache = client ? new RedisCache(client, { namespace, guard }) : new MemoryCache({ maxEntries: 1000 });
  }

  const info = (): CacheInfo => ({
    redis: client === null ? "disabled" : guard.isDegraded || (ioredis !== null && ioredis.status !== "ready") ? "degraded" : "connected",
    cache: !cacheOn ? "off" : client === null ? "memory" : guard.isDegraded ? "memory" : "redis",
  });

  fastify.decorate("redis", ioredis);
  fastify.decorate("cache", cache);
  fastify.decorate("rateLimitStore", client ? (scope: string) => createRateLimitStore({ client, guard, namespace, scope }) : undefined);
  fastify.decorate("cacheInfo", info);

  if (ioredis) {
    // Never block or fail boot on Redis: wait briefly just to log an accurate line.
    const ready = await waitForReady(ioredis, opts.bootWaitMs ?? BOOT_WAIT_MS);
    fastify.log.info(
      ready
        ? `redis: active (shared rate limits; cache ${cacheOn ? "on" : "off"})`
        : "redis: configured but not reachable yet, running degraded (in-memory) and reconnecting in the background",
    );
    fastify.addHook("onClose", async () => {
      try {
        await ioredis!.quit();
      } catch {
        ioredis!.disconnect();
      }
    });
  } else if (injected && client) {
    fastify.log.info(`redis: active via injected client (cache ${cacheOn ? "on" : "off"})`);
  } else {
    fastify.log.info(`redis: disabled (REDIS_URL not set), rate limits are per process; cache ${cacheOn ? "in-memory" : "off"}`);
  }
}

export default fp(redisPlugin, { name: "redis" });
