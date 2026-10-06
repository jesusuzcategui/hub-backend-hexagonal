import { describe, it, expect } from "vitest";
import { assertSafeTestDb } from "../test-db-guard";

const dev = "postgres://hub:secret@localhost:5441/hubdb";

describe("assertSafeTestDb", () => {
  it("does nothing outside vitest, so production and the migrate script are untouched", () => {
    expect(() => assertSafeTestDb(dev, {})).not.toThrow();
  });

  it("refuses a database whose name is not a throwaway one when running under vitest", () => {
    expect(() => assertSafeTestDb(dev, { VITEST: "true" })).toThrow(/hubdb/);
  });

  it.each(["hub_it", "hub_test", "hub_rem", "hub_ser", "x_it"])("accepts the throwaway database %s", (name) => {
    expect(() => assertSafeTestDb(`postgres://postgres:x@localhost:5433/${name}`, { VITEST: "true" })).not.toThrow();
  });

  it("does not match a name that merely contains the suffix in the middle", () => {
    expect(() => assertSafeTestDb("postgres://u:p@localhost:5433/hub_item", { VITEST: "true" })).toThrow();
  });

  it("can be overridden on purpose with ALLOW_DEV_DB=true", () => {
    expect(() => assertSafeTestDb(dev, { VITEST: "true", ALLOW_DEV_DB: "true" })).not.toThrow();
  });

  it("only the exact value 'true' overrides it", () => {
    expect(() => assertSafeTestDb(dev, { VITEST: "true", ALLOW_DEV_DB: "1" })).toThrow();
  });

  it("treats an unparsable url as unsafe under vitest", () => {
    expect(() => assertSafeTestDb("not a url", { VITEST: "true" })).toThrow();
  });

  it("never leaks the password in the error message", () => {
    let message = "";
    try {
      assertSafeTestDb(dev, { VITEST: "true" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("secret");
    expect(message).toContain("ALLOW_DEV_DB");
  });
});
