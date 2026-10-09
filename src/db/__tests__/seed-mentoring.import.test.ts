import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: seed-mentoring.ts used to end with an unconditional `main()`, so merely IMPORTING it (migrate.ts does,
// on its first lines) opened a connection and seeded BEFORE runMigrations() had applied a single migration. On a
// database one migration behind (accounts.locale missing) that crashed the whole boot in a restart loop.
const poolCtor = vi.hoisted(() => vi.fn());

vi.mock("dotenv/config", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    constructor(...args: unknown[]) {
      poolCtor(...args);
    }
    query = vi.fn().mockRejectedValue(new Error("must not be queried on import"));
    end = vi.fn();
  },
}));
vi.mock("../../config/env.js", () => ({ env: { mentoring: { teacherId: "00000000-0000-4000-8000-000000000000" } } }));

describe("seed-mentoring import", () => {
  afterEach(() => {
    vi.resetModules();
    poolCtor.mockClear();
  });

  it("does not open a database connection or seed just because it is imported", async () => {
    const mod = await import("../seed-mentoring.js");
    await new Promise((resolve) => setTimeout(resolve, 50)); // let a stray main() reach its first await
    expect(typeof mod.seedMentoring).toBe("function");
    expect(poolCtor).not.toHaveBeenCalled();
  });
});
