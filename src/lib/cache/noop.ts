import type { Cache } from "./types";

/** Pass-through cache: every read misses, every write is dropped. Used when caching is switched off. */
export const noopCache: Cache = {
  backend: "none",
  async get() {
    return null;
  },
  async set() {},
  async del() {},
  async delByPrefix() {},
};
