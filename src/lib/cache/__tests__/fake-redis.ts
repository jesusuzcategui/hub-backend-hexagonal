import type { RedisLike } from "../types";

export type FakeMode = "ok" | "throw" | "hang";

/** In-memory stand-in for the ioredis methods the cache adapters use. Never talks to a network. */
export class FakeRedis implements RedisLike {
  mode: FakeMode = "ok";
  calls = 0;
  readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  constructor(public now: () => number = Date.now) {}

  private async gate(): Promise<void> {
    this.calls++;
    if (this.mode === "throw") throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    if (this.mode === "hang") await new Promise(() => {});
  }

  private live(key: string) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string) {
    await this.gate();
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, _mode: "EX", seconds: number) {
    await this.gate();
    this.store.set(key, { value, expiresAt: this.now() + seconds * 1000 });
    return "OK";
  }
  async del(...keys: string[]) {
    await this.gate();
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async scan(_cursor: string, _m: "MATCH", pattern: string, _c: "COUNT", _n: number): Promise<[string, string[]]> {
    await this.gate();
    // Supports the only glob the adapter emits: an escaped literal followed by a trailing '*'.
    const literal = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
    const keys = [...this.store.keys()].filter((k) => k.startsWith(literal) && this.live(k));
    return ["0", keys];
  }
  /** Emulates the rate-limit INCR script (fixed window). */
  async eval(_script: string, _numKeys: number, ...args: (string | number)[]) {
    await this.gate();
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const e = this.live(key);
    if (!e) {
      this.store.set(key, { value: "1", expiresAt: this.now() + windowMs });
      return [1, windowMs];
    }
    e.value = String(Number(e.value) + 1);
    return [Number(e.value), (e.expiresAt ?? this.now()) - this.now()];
  }
}
