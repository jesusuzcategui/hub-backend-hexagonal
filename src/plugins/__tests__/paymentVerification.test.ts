import { describe, it, expect, vi } from "vitest";
import { paymentVerificationEnabled } from "../paymentVerification";
import { createGuardedTick } from "../reminders";

describe("paymentVerificationEnabled", () => {
  it("is on by default (production images do not set NODE_ENV)", () => {
    expect(paymentVerificationEnabled({})).toBe(true);
    expect(paymentVerificationEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(paymentVerificationEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it("is off when PAYMENT_AUTOVERIFY_ENABLED is the string 'false' (case-insensitive)", () => {
    expect(paymentVerificationEnabled({ PAYMENT_AUTOVERIFY_ENABLED: "false" })).toBe(false);
    expect(paymentVerificationEnabled({ PAYMENT_AUTOVERIFY_ENABLED: "FALSE" })).toBe(false);
    expect(paymentVerificationEnabled({ PAYMENT_AUTOVERIFY_ENABLED: "true" })).toBe(true);
  });

  it("is always off under NODE_ENV=test, even if explicitly enabled (a test boot never calls ePayco)", () => {
    expect(paymentVerificationEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(paymentVerificationEnabled({ NODE_ENV: "test", PAYMENT_AUTOVERIFY_ENABLED: "true" })).toBe(false);
  });

  it("is independent of REMINDERS_ENABLED", () => {
    expect(paymentVerificationEnabled({ REMINDERS_ENABLED: "false" } as { NODE_ENV?: string })).toBe(true);
  });
});

describe("createGuardedTick label", () => {
  it("prefixes its log lines with the given label", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tick = createGuardedTick(async () => { throw new Error("x"); }, log, "payment-verification");
    await tick();
    expect(log.error).toHaveBeenCalledWith(expect.anything(), "payment-verification: run failed");
  });
});
