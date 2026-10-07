/**
 * Minimal cache port. Values are JSON-serializable; a miss is `null`. Implementations must never throw
 * because of their backend: a failing cache behaves like an empty one (reads miss, writes are dropped).
 */
export interface Cache {
  /** Which adapter is serving requests right now. "redis" flips to "memory" while Redis is degraded. */
  readonly backend: "memory" | "redis" | "none";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Removes every entry whose key starts with `prefix`. Only touches this deployment's namespace. */
  delByPrefix(prefix: string): Promise<void>;
}

/** The subset of ioredis the adapters use, so tests can inject a fake and nothing else is reachable. */
export interface RedisLike {
  readonly status?: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface CacheLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
