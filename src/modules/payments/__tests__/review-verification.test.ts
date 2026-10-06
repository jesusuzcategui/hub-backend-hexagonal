import { describe, it, expect } from "vitest";
import {
  REVIEW_VERIFY_OFFSETS_MIN,
  REVIEW_WINDOW_MIN,
  parseVerifySchedule,
  nextVerifyDelayMs,
  isWindowExpired,
  contrasteMatchesOrder,
  decideAfterContraste,
  studentFacingFulfillment,
  planNextVerifyAt,
} from "../review-verification";

const MIN = 60_000;
const flaggedAt = new Date("2026-10-10T12:00:00Z");
const at = (minutes: number) => new Date(flaggedAt.getTime() + minutes * MIN);

describe("schedule constants", () => {
  it("retries 2, 5, 10, 20 and 40 minutes after the flag, window of 60 minutes", () => {
    expect(REVIEW_VERIFY_OFFSETS_MIN).toEqual([2, 5, 10, 20, 40]);
    expect(REVIEW_WINDOW_MIN).toBe(60);
  });
});

describe("nextVerifyDelayMs (offset from the flag at which the next attempt is due)", () => {
  it.each([
    [0, 2],
    [1, 5],
    [2, 10],
    [3, 20],
    [4, 40],
  ])("after %i attempts the next one is due %i minutes after the flag", (done, minutes) => {
    expect(nextVerifyDelayMs(done)).toBe(minutes * MIN);
  });

  it("falls to the end of the window once the schedule is exhausted (final attempt + alert)", () => {
    expect(nextVerifyDelayMs(5)).toBe(60 * MIN);
    expect(nextVerifyDelayMs(99)).toBe(60 * MIN);
  });

  it("treats a negative or fractional attempt count defensively", () => {
    expect(nextVerifyDelayMs(-3)).toBe(2 * MIN);
    expect(nextVerifyDelayMs(1.9)).toBe(5 * MIN);
  });

  it("honours a custom schedule and window", () => {
    const cfg = { offsetsMin: [1, 3], windowMin: 10 };
    expect(nextVerifyDelayMs(0, cfg)).toBe(1 * MIN);
    expect(nextVerifyDelayMs(1, cfg)).toBe(3 * MIN);
    expect(nextVerifyDelayMs(2, cfg)).toBe(10 * MIN);
  });
});

describe("isWindowExpired", () => {
  it("is false before the window end and true exactly at it", () => {
    expect(isWindowExpired(flaggedAt, at(59.99))).toBe(false);
    expect(isWindowExpired(flaggedAt, at(60))).toBe(true);
    expect(isWindowExpired(flaggedAt, at(600))).toBe(true);
  });

  it("treats a missing flaggedAt as expired so the order is never retried forever", () => {
    expect(isWindowExpired(null, flaggedAt)).toBe(true);
    expect(isWindowExpired(undefined, flaggedAt)).toBe(true);
  });

  it("honours a custom window", () => {
    expect(isWindowExpired(flaggedAt, at(9), { offsetsMin: [1], windowMin: 10 })).toBe(false);
    expect(isWindowExpired(flaggedAt, at(10), { offsetsMin: [1], windowMin: 10 })).toBe(true);
  });
});

describe("planNextVerifyAt", () => {
  it("schedules from the flag time, never earlier than one minute from now", () => {
    expect(planNextVerifyAt(flaggedAt, 1, at(2))).toEqual(at(5));
    // service was down: the computed time is in the past, so wait one minute instead of hammering ePayco
    expect(planNextVerifyAt(flaggedAt, 1, at(30))).toEqual(at(31));
  });

  it("falls back to now + 1 minute when flaggedAt is missing", () => {
    expect(planNextVerifyAt(null, 1, at(3))).toEqual(at(4));
  });
});

describe("parseVerifySchedule (env)", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseVerifySchedule({})).toEqual({ offsetsMin: [2, 5, 10, 20, 40], windowMin: 60 });
  });

  it("parses a comma separated schedule and a window", () => {
    expect(parseVerifySchedule({ PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES: "1, 4,9", PAYMENT_AUTOVERIFY_WINDOW_MINUTES: "30" })).toEqual({
      offsetsMin: [1, 4, 9],
      windowMin: 30,
    });
  });

  it.each([
    ["garbage", "a,b"],
    ["empty", ""],
    ["non increasing", "5,3"],
    ["zero", "0,5"],
    ["negative", "-1,5"],
  ])("falls back to the default schedule on %s", (_n, value) => {
    expect(parseVerifySchedule({ PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES: value }).offsetsMin).toEqual([2, 5, 10, 20, 40]);
  });

  it("falls back to the default window on garbage and drops offsets past the window", () => {
    expect(parseVerifySchedule({ PAYMENT_AUTOVERIFY_WINDOW_MINUTES: "x" }).windowMin).toBe(60);
    expect(parseVerifySchedule({ PAYMENT_AUTOVERIFY_WINDOW_MINUTES: "0" }).windowMin).toBe(60);
    expect(
      parseVerifySchedule({ PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES: "2,5,10,20,40", PAYMENT_AUTOVERIFY_WINDOW_MINUTES: "15" }),
    ).toEqual({ offsetsMin: [2, 5, 10], windowMin: 15 });
  });
});

const order = { id: "ord-1", amountMinor: 150_000, currency: "COP" };
const good = { invoice: "ord-1", amountMinor: 150_000, currency: "COP" };

describe("contrasteMatchesOrder", () => {
  it("matches when invoice, amount and currency agree (currency case-insensitive on the order)", () => {
    expect(contrasteMatchesOrder(good, { ...order, currency: "cop" }, { isApproved: true })).toBe(true);
  });

  it("always requires the invoice", () => {
    expect(contrasteMatchesOrder({ ...good, invoice: "other" }, order, { isApproved: false })).toBe(false);
  });

  it("only asserts amount and currency for approved payments (webhook rule, unchanged)", () => {
    const wrong = { ...good, amountMinor: 1, currency: "USD" };
    expect(contrasteMatchesOrder(wrong, order, { isApproved: false })).toBe(true);
    expect(contrasteMatchesOrder(wrong, order, { isApproved: true })).toBe(false);
  });
});

describe("decideAfterContraste", () => {
  it("clears on an exact match", () => {
    expect(decideAfterContraste({ kind: "data", contraste: good }, order)).toBe("clear");
  });

  it.each([
    ["different invoice", { ...good, invoice: "ord-2" }],
    ["different amount", { ...good, amountMinor: 149_999 }],
    ["different currency", { ...good, currency: "USD" }],
    ["empty invoice", { ...good, invoice: "" }],
    ["zero amount", { ...good, amountMinor: 0 }],
  ])("reports a mismatch on %s", (_n, contraste) => {
    expect(decideAfterContraste({ kind: "data", contraste }, order)).toBe("mismatch");
  });

  it("reports unavailable when ePayco could not answer", () => {
    expect(decideAfterContraste({ kind: "unavailable" }, order)).toBe("unavailable");
  });
});

describe("studentFacingFulfillment", () => {
  it.each([
    ["needs_review", "contraste_unavailable", "delivered"],
    ["needs_review", "fulfillment_failed", "needs_review"],
    ["needs_review", "contraste_mismatch", "needs_review"],
    ["needs_review", null, "needs_review"],
    ["delivered", null, "delivered"],
    ["delivered", "contraste_unavailable", "delivered"],
    ["pending", null, "pending"],
    ["pending", "contraste_unavailable", "pending"],
  ] as const)("%s + reason %s -> %s", (fulfillmentStatus, reviewReason, expected) => {
    expect(studentFacingFulfillment({ fulfillmentStatus, reviewReason })).toBe(expected);
  });
});
