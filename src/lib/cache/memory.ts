import type { Cache } from "./types";

interface Entry {
  json: string;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** Hard bound on entries; the oldest entries are evicted first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * In-process TTL cache. Expiry is lazy (checked on read and during eviction), so there are no timers and
 * nothing keeps the process alive. Values are stored serialized so callers never share mutable objects, which
 * also keeps its behavior identical to the Redis adapter.
 */
export class MemoryCache implements Cache {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.json) as T;
    } catch {
      this.entries.delete(key);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!(ttlSeconds > 0)) return;
    const json = JSON.stringify(value);
    if (json === undefined) return;
    this.entries.delete(key); // re-insert so it counts as the newest entry
    if (this.entries.size >= this.maxEntries) this.makeRoom();
    this.entries.set(key, { json, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  private makeRoom(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Map iterates in insertion order, so the first keys are the oldest.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
