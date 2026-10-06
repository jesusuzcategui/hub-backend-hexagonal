import { describe, it, expect } from "vitest";
import { registerSchema } from "../auth.schemas";
import { updateProfileSchema } from "../../users/users.schemas";

const reg = { email: "a@b.co", password: "Password123!", displayName: "Ana" };

describe("registerSchema locale", () => {
  it("defaults to es when omitted", () => {
    expect(registerSchema.parse(reg).locale).toBe("es");
  });
  it("keeps es and en", () => {
    expect(registerSchema.parse({ ...reg, locale: "en" }).locale).toBe("en");
    expect(registerSchema.parse({ ...reg, locale: "es" }).locale).toBe("es");
  });
  it.each(["fr", "EN", "", null, 5, {}])("ignores %j and falls back to es without failing registration", (bad) => {
    const parsed = registerSchema.safeParse({ ...reg, locale: bad });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.locale).toBe("es");
  });
});

describe("updateProfileSchema locale", () => {
  it("accepts es and en", () => {
    expect(updateProfileSchema.parse({ locale: "en" }).locale).toBe("en");
  });
  it("rejects anything else (explicit change must be valid)", () => {
    expect(updateProfileSchema.safeParse({ locale: "fr" }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ locale: "" }).success).toBe(false);
  });
});
