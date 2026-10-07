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
  async incr(key: string) {
    await this.gate();
    const e = this.live(key);
    const next = Number(e?.value ?? 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: e?.expiresAt ?? null });
    return next;
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
