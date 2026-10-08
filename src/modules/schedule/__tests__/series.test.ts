import { describe, it, expect } from "vitest";
import { AppError } from "../../../lib/errors";
import {
  MAX_SERIES_HORIZON_WEEKS,
  allocateCreditsByDate,
  applyCreditCoverage,
  classifyOccurrences,
  generateOccurrences,
  splitSeriesRequest,
  validateSeriesRule,
  type ClassifyContext,
  type SeriesRule,
} from "../series";

const H = 3_600_000;
// Tue 2026-10-06 10:00 in Bogota (UTC-5, no DST).
const NOW = new Date("2026-10-06T15:00:00Z");

function rule(over: Partial<SeriesRule> = {}): SeriesRule {
  return {
    pattern: [{ weekday: 3, time: "10:00" }],
    intervalWeeks: 1,
    startDate: "2026-10-06",
    occurrences: 4,
    ...over,
  };
}

function expectValidation(fn: () => unknown, messagePart?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    if (messagePart) expect((err as AppError).message).toContain(messagePart);
    return;
  }
  throw new Error("expected a VALIDATION_ERROR AppError");
}

describe("validateSeriesRule", () => {
  it("accepts a well-formed rule and returns it normalized", () => {
    const out = validateSeriesRule({
      pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }],
      intervalWeeks: 2,
      startDate: "2026-10-12",
      occurrences: 8,
      extra: "ignored",
    });
    expect(out).toEqual({
      pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }],
      intervalWeeks: 2,
      startDate: "2026-10-12",
      occurrences: 8,
    });
  });

  it.each([
    ["non-object", null],
    ["missing pattern", { intervalWeeks: 1, startDate: "2026-10-12", occurrences: 1 }],
    ["empty pattern", rule({ pattern: [] })],
    ["more than 7 items", rule({ pattern: Array.from({ length: 8 }, (_, i) => ({ weekday: i % 7, time: `0${i}:00` })) })],
    ["weekday 7", rule({ pattern: [{ weekday: 7, time: "10:00" }] })],
    ["weekday -1", rule({ pattern: [{ weekday: -1, time: "10:00" }] })],
    ["fractional weekday", rule({ pattern: [{ weekday: 1.5, time: "10:00" }] })],
    ["time without zero pad", rule({ pattern: [{ weekday: 1, time: "6:00" }] })],
    ["time 24:00", rule({ pattern: [{ weekday: 1, time: "24:00" }] })],
    ["time 06:60", rule({ pattern: [{ weekday: 1, time: "06:60" }] })],
    ["duplicate weekday+time", rule({ pattern: [{ weekday: 1, time: "10:00" }, { weekday: 1, time: "10:00" }] })],
    ["intervalWeeks 0", rule({ intervalWeeks: 0 })],
    ["intervalWeeks 9", rule({ intervalWeeks: 9 })],
    ["occurrences 0", rule({ occurrences: 0 })],
    ["occurrences 51", rule({ occurrences: 51 })],
    ["occurrences as string", { ...rule(), occurrences: "4" }],
    ["startDate wrong format", rule({ startDate: "2026/10/06" })],
    ["startDate impossible date", rule({ startDate: "2026-02-30" })],
  ])("rejects %s", (_name, input) => {
    expectValidation(() => validateSeriesRule(input));
  });

  it("allows the same weekday at different times", () => {
    const out = validateSeriesRule(rule({ pattern: [{ weekday: 1, time: "06:00" }, { weekday: 1, time: "18:00" }] }));
    expect(out.pattern).toHaveLength(2);
  });
});

describe("generateOccurrences", () => {
  const dates = (r: SeriesRule, now = NOW) => generateOccurrences(r, now).map((o) => o.date);

  it("exposes the horizon cap as a named constant", () => {
    expect(MAX_SERIES_HORIZON_WEEKS).toBe(16);
  });

  it("weekly, one weekday", () => {
    const occ = generateOccurrences(rule(), NOW);
    expect(occ.map((o) => o.date)).toEqual(["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"]);
    expect(occ[0].startsAt.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(occ[0].endsAt.getTime() - occ[0].startsAt.getTime()).toBe(H);
    expect(occ[0]).toMatchObject({ time: "10:00", weekday: 3, dateKey: "20261007", timeKey: "1000" });
  });

  it("two classes every 15 days = two weekdays with intervalWeeks 2", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "06:00" }, { weekday: 4, time: "06:00" }], intervalWeeks: 2, startDate: "2026-10-12", occurrences: 4 });
    expect(dates(r)).toEqual(["2026-10-12", "2026-10-15", "2026-10-26", "2026-10-29"]);
  });

  it("Monday + Wednesday at 06:00 weekly x8", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }], startDate: "2026-10-12", occurrences: 8 });
    const occ = generateOccurrences(r, NOW);
    expect(occ.map((o) => o.date)).toEqual([
      "2026-10-12", "2026-10-14", "2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04",
    ]);
    expect(occ[0].startsAt.toISOString()).toBe("2026-10-12T11:00:00.000Z");
  });

  it("startDate in the middle of a week skips earlier days of that week", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }], startDate: "2026-10-14", occurrences: 3 });
    expect(dates(r)).toEqual(["2026-10-14", "2026-10-19", "2026-10-21"]);
  });

  it("orders each week Monday first and Sunday last regardless of pattern order", () => {
    const r = rule({ pattern: [{ weekday: 0, time: "10:00" }, { weekday: 3, time: "10:00" }, { weekday: 1, time: "10:00" }], startDate: "2026-10-12", occurrences: 6 });
    expect(dates(r)).toEqual(["2026-10-12", "2026-10-14", "2026-10-18", "2026-10-19", "2026-10-21", "2026-10-25"]);
  });

  it("orders several times on the same weekday by time", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "18:00" }, { weekday: 1, time: "06:00" }], startDate: "2026-10-12", occurrences: 3 });
    expect(generateOccurrences(r, NOW).map((o) => `${o.date} ${o.time}`)).toEqual(["2026-10-12 06:00", "2026-10-12 18:00", "2026-10-19 06:00"]);
  });

  it("handles weekday 6 (Saturday) and 0 (Sunday)", () => {
    expect(dates(rule({ pattern: [{ weekday: 6, time: "09:00" }], startDate: "2026-10-12", occurrences: 2 }))).toEqual(["2026-10-17", "2026-10-24"]);
    expect(dates(rule({ pattern: [{ weekday: 0, time: "09:00" }], startDate: "2026-10-12", occurrences: 2 }))).toEqual(["2026-10-18", "2026-10-25"]);
  });

  it("a Sunday startDate belongs to the week that started on the previous Monday", () => {
    const r = rule({ pattern: [{ weekday: 0, time: "09:00" }, { weekday: 1, time: "09:00" }], startDate: "2026-10-11", occurrences: 3 });
    expect(dates(r)).toEqual(["2026-10-11", "2026-10-12", "2026-10-18"]);
  });

  it("a single occurrence", () => {
    expect(dates(rule({ occurrences: 1 }))).toEqual(["2026-10-07"]);
  });

  it("crosses a year boundary", () => {
    const r = rule({ pattern: [{ weekday: 4, time: "10:00" }], startDate: "2026-12-24", occurrences: 3 });
    expect(dates(r, new Date("2026-12-20T12:00:00Z"))).toEqual(["2026-12-24", "2026-12-31", "2027-01-07"]);
  });

  it("the last occurrence may be exactly 16 weeks after startDate", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "06:00" }], startDate: "2026-10-12", occurrences: 17 });
    const out = generateOccurrences(r, NOW);
    expect(out).toHaveLength(17);
    expect(out[16].date).toBe("2027-02-01"); // 2026-10-12 + 112 days
  });

  it("rejects a series whose last occurrence is more than 16 weeks after startDate", () => {
    const r = rule({ pattern: [{ weekday: 1, time: "06:00" }], startDate: "2026-10-12", occurrences: 18 });
    expectValidation(() => generateOccurrences(r, NOW), "16 weeks");
  });

  it("rejects a startDate before today (Bogota)", () => {
    expectValidation(() => generateOccurrences(rule({ startDate: "2026-10-05" }), NOW), "past");
  });

  it("allows startDate = today in Bogota even late at night UTC", () => {
    // 2026-10-07T03:00Z = Oct 6 22:00 Bogota
    expect(() => generateOccurrences(rule({ startDate: "2026-10-06" }), new Date("2026-10-07T03:00:00Z"))).not.toThrow();
    // 2026-10-07T05:00Z = Oct 7 00:00 Bogota: Oct 6 is now in the past
    expectValidation(() => generateOccurrences(rule({ startDate: "2026-10-06" }), new Date("2026-10-07T05:00:00Z")), "past");
  });

  it("keeps occurrences earlier today so they can be reported as in_past", () => {
    const r = rule({ pattern: [{ weekday: 2, time: "06:00" }], startDate: "2026-10-06", occurrences: 2 });
    expect(dates(r)).toEqual(["2026-10-06", "2026-10-13"]);
  });
});

describe("classifyOccurrences", () => {
  const SLOT = { id: "11111111-1111-1111-1111-111111111111", dayOfWeek: 3, startTime: "06:00", endTime: "08:00", isActive: true };
  const baseRule = rule({ pattern: [{ weekday: 3, time: "06:00" }], startDate: "2026-10-14", occurrences: 2 }); // Wed 10-14, 10-21
  const occs = generateOccurrences(baseRule, NOW);

  function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
    return { weeklySlots: [SLOT], taken: [], blocked: [], studentBookings: [], now: NOW, ...over };
  }
  const statuses = (c: ClassifyContext, input = occs) => classifyOccurrences(input, c).map((o) => o.status);

  it("marks everything ok and builds the composite slot id", () => {
    const out = classifyOccurrences(occs, ctx());
    expect(out.map((o) => o.status)).toEqual(["ok", "ok"]);
    expect(out[0].weeklySlotId).toBe(SLOT.id);
    expect(out[0].slotId).toBe(`${SLOT.id}_20261014_0600`);
  });

  it("no_slot: no active weekly slot that weekday, inactive slot, or time not on an hour chunk", () => {
    expect(statuses(ctx({ weeklySlots: [] }))).toEqual(["no_slot", "no_slot"]);
    expect(statuses(ctx({ weeklySlots: [{ ...SLOT, isActive: false }] }))).toEqual(["no_slot", "no_slot"]);
    expect(statuses(ctx({ weeklySlots: [{ ...SLOT, dayOfWeek: 2 }] }))).toEqual(["no_slot", "no_slot"]);
    const off = generateOccurrences(rule({ pattern: [{ weekday: 3, time: "06:30" }], startDate: "2026-10-14", occurrences: 1 }), NOW);
    expect(statuses(ctx(), off)).toEqual(["no_slot"]);
  });

  it("accepts the second hour chunk of a multi-hour slot", () => {
    const seven = generateOccurrences(rule({ pattern: [{ weekday: 3, time: "07:00" }], startDate: "2026-10-14", occurrences: 1 }), NOW);
    expect(statuses(ctx(), seven)).toEqual(["ok"]);
    const eight = generateOccurrences(rule({ pattern: [{ weekday: 3, time: "08:00" }], startDate: "2026-10-14", occurrences: 1 }), NOW);
    expect(statuses(ctx(), eight)).toEqual(["no_slot"]);
  });

  it("slot_taken: someone holds that slot at that start", () => {
    const taken = [{ weeklySlotId: SLOT.id, startsAt: occs[1].startsAt }];
    expect(statuses(ctx({ taken }))).toEqual(["ok", "slot_taken"]);
  });

  it("a booking on another weekly slot or another start does not take this one", () => {
    const taken = [
      { weeklySlotId: "22222222-2222-2222-2222-222222222222", startsAt: occs[0].startsAt },
      { weeklySlotId: SLOT.id, startsAt: new Date(occs[0].startsAt.getTime() + H) },
    ];
    expect(statuses(ctx({ taken }))).toEqual(["ok", "ok"]);
  });

  it("with two weekly slots at the same time, free one is used; both taken = slot_taken", () => {
    const other = { ...SLOT, id: "00000000-0000-0000-0000-000000000009" };
    const takenOne = [{ weeklySlotId: other.id, startsAt: occs[0].startsAt }];
    const out = classifyOccurrences(occs, ctx({ weeklySlots: [SLOT, other], taken: takenOne }));
    expect(out[0].status).toBe("ok");
    expect(out[0].weeklySlotId).toBe(SLOT.id);
    const takenBoth = [
      { weeklySlotId: other.id, startsAt: occs[0].startsAt },
      { weeklySlotId: SLOT.id, startsAt: occs[0].startsAt },
    ];
    expect(statuses(ctx({ weeklySlots: [SLOT, other], taken: takenBoth }))[0]).toBe("slot_taken");
  });

  it("blocked: overlaps a blocked range (touching ranges do not overlap)", () => {
    const s = occs[0].startsAt.getTime();
    expect(statuses(ctx({ blocked: [{ startsAt: new Date(s - H / 2), endsAt: new Date(s + H / 2) }] }))).toEqual(["blocked", "ok"]);
    expect(statuses(ctx({ blocked: [{ startsAt: new Date(s - H), endsAt: new Date(s) }] }))).toEqual(["ok", "ok"]);
    expect(statuses(ctx({ blocked: [{ startsAt: new Date(s + H), endsAt: new Date(s + 2 * H) }] }))).toEqual(["ok", "ok"]);
  });

  it("student_busy: the student already has a booking overlapping that hour", () => {
    const s = occs[1].startsAt.getTime();
    expect(statuses(ctx({ studentBookings: [{ startsAt: new Date(s + H / 2), endsAt: new Date(s + 1.5 * H) }] }))).toEqual(["ok", "student_busy"]);
    expect(statuses(ctx({ studentBookings: [{ startsAt: new Date(s + H), endsAt: new Date(s + 2 * H) }] }))).toEqual(["ok", "ok"]);
  });

  it("in_past wins over every other reason", () => {
    const early = generateOccurrences(rule({ pattern: [{ weekday: 2, time: "06:00" }], startDate: "2026-10-06", occurrences: 2 }), NOW);
    expect(statuses(ctx({ weeklySlots: [] }), early)).toEqual(["in_past", "no_slot"]);
    const late = new Date(early[1].startsAt.getTime() + 1);
    expect(statuses(ctx({ weeklySlots: [], now: late }), early)).toEqual(["in_past", "in_past"]);
  });

  it("reports the first matching reason in the order no_slot, blocked, slot_taken, student_busy", () => {
    const s = occs[0].startsAt;
    const all = ctx({
      taken: [{ weeklySlotId: SLOT.id, startsAt: s }],
      blocked: [{ startsAt: s, endsAt: new Date(s.getTime() + H) }],
      studentBookings: [{ startsAt: s, endsAt: new Date(s.getTime() + H) }],
    });
    expect(statuses(all)[0]).toBe("blocked");
    expect(statuses({ ...all, blocked: [] })[0]).toBe("slot_taken");
    expect(statuses({ ...all, blocked: [], taken: [] })[0]).toBe("student_busy");
  });

  it("does not mutate its inputs", () => {
    const c = ctx({ taken: [{ weeklySlotId: SLOT.id, startsAt: occs[0].startsAt }] });
    const snapshot = JSON.stringify(c);
    classifyOccurrences(occs, c);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe("allocateCreditsByDate", () => {
  const mk = (id: string, total: number, used: number, expiresInDays: number | null, createdDaysAgo: number) => ({
    id,
    totalCredits: total,
    usedCredits: used,
    expiresAt: expiresInDays === null ? null : new Date(NOW.getTime() + expiresInDays * 24 * H),
    createdAt: new Date(NOW.getTime() - createdDaysAgo * 24 * H),
  });
  const at = (days: number) => new Date(NOW.getTime() + days * 24 * H);

  it("consumes the block that expires first, then the next, one credit per occurrence", () => {
    const blocks = [mk("late", 5, 0, 30, 10), mk("soon", 3, 0, 5, 20)];
    const out = allocateCreditsByDate(blocks, [1, 2, 3, 4, 5, 6].map(at), NOW);
    expect(out.map((o) => o.creditId)).toEqual(["soon", "soon", "soon", "late", "late", "late"]);
  });

  it("assigns per occurrence: the early block only covers the early dates", () => {
    const blocks = [mk("early", 5, 0, 10, 20), mk("late", 5, 0, 40, 10)];
    const out = allocateCreditsByDate(blocks, [2, 12, 20].map(at), NOW);
    expect(out.map((o) => o.creditId)).toEqual(["early", "late", "late"]);
  });

  it("marks occurrences no block covers as after_credit_expiry (blocks with credit exist)", () => {
    const out = allocateCreditsByDate([mk("a", 5, 0, 10, 1)], [2, 12, 13].map(at), NOW);
    expect(out).toEqual([
      { creditId: "a" },
      { creditId: null, reason: "after_credit_expiry" },
      { creditId: null, reason: "after_credit_expiry" },
    ]);
  });

  it("marks occurrences as no_credits when nothing with credit is left at all", () => {
    const out = allocateCreditsByDate([mk("a", 1, 0, 30, 1)], [1, 2].map(at), NOW);
    expect(out).toEqual([{ creditId: "a" }, { creditId: null, reason: "no_credits" }]);
  });

  it("does not mutate the input blocks and ignores expired and exhausted ones", () => {
    const blocks = [mk("expired", 5, 0, -1, 40), mk("full", 2, 2, 10, 5), mk("ok", 2, 1, 10, 3)];
    const out = allocateCreditsByDate(blocks, [at(1)], NOW);
    expect(out).toEqual([{ creditId: "ok" }]);
    expect(blocks.map((b) => b.usedCredits)).toEqual([0, 2, 1]);
  });

  it("never-expiring blocks go last and cover any date", () => {
    const out = allocateCreditsByDate([mk("never", 1, 0, null, 1), mk("dated", 1, 0, 3, 1)], [1, 100].map(at), NOW);
    expect(out.map((o) => o.creditId)).toEqual(["dated", "never"]);
    expect(allocateCreditsByDate([], [], NOW)).toEqual([]);
  });
});

describe("applyCreditCoverage", () => {
  const H24 = 24 * H;
  const occ = (days: number, status: "ok" | "blocked" = "ok") => {
    const startsAt = new Date(NOW.getTime() + days * H24);
    return { startsAt, endsAt: new Date(startsAt.getTime() + H), status, date: "", time: "", weekday: 0, dateKey: "", timeKey: "", weeklySlotId: "s", slotId: "s_x" } as any;
  };
  const blk = { id: "a", totalCredits: 5, usedCredits: 0, expiresAt: new Date(NOW.getTime() + 10 * H24), createdAt: new Date(NOW.getTime() - H24) };

  it("flips ok occurrences past the credit expiry to after_credit_expiry and leaves other statuses alone", () => {
    const { occurrences, creditByStart, unfunded } = applyCreditCoverage([occ(2), occ(3, "blocked"), occ(12)], [blk], NOW);
    expect(occurrences.map((o) => o.status)).toEqual(["ok", "blocked", "after_credit_expiry"]);
    expect([...creditByStart.values()]).toEqual(["a"]);
    expect(unfunded).toBe(0);
  });

  it("counts ok occurrences nobody can pay for as unfunded (they stay ok)", () => {
    const one = { ...blk, totalCredits: 1 };
    const { occurrences, unfunded } = applyCreditCoverage([occ(1), occ(2)], [one], NOW);
    expect(occurrences.map((o) => o.status)).toEqual(["ok", "ok"]);
    expect(unfunded).toBe(1);
  });
});

describe("splitSeriesRequest", () => {
  it("separates skipConflicts (default false) from the rule fields", () => {
    expect(splitSeriesRequest(rule())).toEqual({ rule: rule(), skipConflicts: false });
    expect(splitSeriesRequest({ ...rule(), skipConflicts: true })).toEqual({ rule: rule(), skipConflicts: true });
  });

  it("rejects a non-boolean skipConflicts and a missing body", () => {
    expectValidation(() => splitSeriesRequest({ ...rule(), skipConflicts: "yes" }), "skipConflicts");
    expectValidation(() => splitSeriesRequest(undefined));
  });
});
