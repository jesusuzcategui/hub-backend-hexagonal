// Pure rules for recurring class series. No DB access: everything the DB-backed service needs to
// decide (which dates, which of them are bookable, which credit block pays for each) is computed
// here so it can be unit-tested.
//
// Timezone: America/Bogota is fixed UTC-5 (no DST), like the rest of the hub, so a local
// "YYYY-MM-DD HH:MM" maps to a UTC instant with a constant offset.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { pickCreditBlockForDate, type CreditBlockLike } from "./credit-balance.js";
import { hourChunks, pad2 } from "./slot-time.js";

/** The LAST occurrence may be at most this many weeks after `startDate`. */
export const MAX_SERIES_HORIZON_WEEKS = 16;
export const MAX_SERIES_OCCURRENCES = 50;
export const MAX_SERIES_INTERVAL_WEEKS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BOGOTA_OFFSET_MS = 5 * HOUR_MS;

export interface SeriesPatternItem {
  /** 0 = Sunday ... 6 = Saturday (same as weekly_slots.day_of_week). */
  weekday: number;
  /** "HH:MM", Bogota local time. */
  time: string;
}

export interface SeriesRule {
  pattern: SeriesPatternItem[];
  intervalWeeks: number;
  /** "YYYY-MM-DD", Bogota local date. */
  startDate: string;
  occurrences: number;
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const ruleSchema = z.object({
  pattern: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24h)"),
      }),
    )
    .min(1, "pattern needs at least 1 item")
    .max(7, "pattern accepts at most 7 items"),
  intervalWeeks: z.number().int().min(1).max(MAX_SERIES_INTERVAL_WEEKS),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .refine(isRealDate, "startDate is not a real calendar date"),
  occurrences: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES),
});

export function validateSeriesRule(input: unknown): SeriesRule {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new AppError(400, "VALIDATION_ERROR", `Invalid series rule${path ? ` (${path})` : ""}: ${issue.message}`);
  }
  const rule = parsed.data;
  const seen = new Set<string>();
  for (const item of rule.pattern) {
    const key = `${item.weekday}_${item.time}`;
    if (seen.has(key)) throw new AppError(400, "VALIDATION_ERROR", "Invalid series rule (pattern): duplicate weekday and time");
    seen.add(key);
  }
  return {
    pattern: rule.pattern.map((p) => ({ weekday: p.weekday, time: p.time })),
    intervalWeeks: rule.intervalWeeks,
    startDate: rule.startDate,
    occurrences: rule.occurrences,
  };
}

export interface SeriesOccurrence {
  /** Bogota local date, YYYY-MM-DD. */
  date: string;
  /** Bogota local time, HH:MM. */
  time: string;
  weekday: number;
  startsAt: Date;
  endsAt: Date;
  /** YYYYMMDD, the date part of the composite slot id. */
  dateKey: string;
  /** HHMM, the time part of the composite slot id. */
  timeKey: string;
}

function utcMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDate(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Today's date in Bogota as YYYY-MM-DD. */
function bogotaToday(now: Date): string {
  return isoDate(now.getTime() - BOGOTA_OFFSET_MS);
}

/**
 * Expands a rule into dated occurrences.
 *
 * Order: weeks are Monday..Sunday. The week that contains `startDate` is week 0; the next weeks
 * used are intervalWeeks, 2*intervalWeeks, ... Inside a week occurrences come in weekday order
 * Monday(1), Tuesday(2), ... Saturday(6), Sunday(0) last, then by time. Dates before `startDate`
 * are skipped. Generation stops after `occurrences` items.
 *
 * Throws VALIDATION_ERROR when startDate is before today (Bogota) or the last occurrence would be
 * more than MAX_SERIES_HORIZON_WEEKS after startDate. Occurrences earlier TODAY are kept: they are
 * classified `in_past` later so the caller can report them.
 */
export function generateOccurrences(rule: SeriesRule, now: Date): SeriesOccurrence[] {
  if (rule.startDate < bogotaToday(now)) {
    throw new AppError(400, "VALIDATION_ERROR", "startDate is in the past");
  }

  const start = utcMidnight(rule.startDate);
  const horizon = start + MAX_SERIES_HORIZON_WEEKS * 7 * DAY_MS;
  const mondayIndex = (weekday: number) => (weekday + 6) % 7; // Mon=0 ... Sun=6
  const week0Monday = start - mondayIndex(new Date(start).getUTCDay()) * DAY_MS;

  const ordered = [...rule.pattern].sort(
    (a, b) => mondayIndex(a.weekday) - mondayIndex(b.weekday) || a.time.localeCompare(b.time),
  );

  const out: SeriesOccurrence[] = [];
  for (let week = 0; out.length < rule.occurrences; week += rule.intervalWeeks) {
    const weekMonday = week0Monday + week * 7 * DAY_MS;
    for (const item of ordered) {
      if (out.length >= rule.occurrences) break;
      const dayMs = weekMonday + mondayIndex(item.weekday) * DAY_MS;
      if (dayMs < start) continue;
      if (dayMs > horizon) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `The series would run past ${MAX_SERIES_HORIZON_WEEKS} weeks after startDate; reduce occurrences or intervalWeeks`,
        );
      }
      const date = isoDate(dayMs);
      const startsAt = new Date(`${date}T${item.time}:00-05:00`);
      out.push({
        date,
        time: item.time,
        weekday: item.weekday,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        dateKey: date.replace(/-/g, ""),
        timeKey: item.time.replace(":", ""),
      });
    }
  }
  return out;
}

export type OccurrenceReason = "no_slot" | "slot_taken" | "blocked" | "student_busy" | "in_past" | "after_credit_expiry";
export type OccurrenceStatus = "ok" | OccurrenceReason;

export interface ClassifyContext {
  weeklySlots: Array<{ id: string; dayOfWeek: number; startTime: string; endTime: string; isActive: boolean }>;
  /** Confirmed/pending bookings by anyone on weekly slots. */
  taken: Array<{ weeklySlotId: string | null; startsAt: Date }>;
  blocked: Array<{ startsAt: Date; endsAt: Date }>;
  /** Confirmed/pending bookings of the student (any kind). */
  studentBookings: Array<{ startsAt: Date; endsAt: Date }>;
  now: Date;
}

export interface ClassifiedOccurrence extends SeriesOccurrence {
  status: OccurrenceStatus;
  /** Weekly slot chosen for this occurrence (null when there is none). */
  weeklySlotId: string | null;
  /** Composite id `weeklySlotId_YYYYMMDD_HHMM`, same format createStudentBooking validates. */
  slotId: string | null;
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && aEnd > bStart;

/**
 * Decides, per occurrence, whether it can be booked. First matching reason wins:
 * in_past, no_slot, blocked, slot_taken, student_busy (after_credit_expiry is added later by
 * applyCreditCoverage, only for occurrences that would otherwise be ok). Pure: callers load the context.
 */
export function classifyOccurrences(occurrences: readonly SeriesOccurrence[], ctx: ClassifyContext): ClassifiedOccurrence[] {
  const takenKeys = new Set(ctx.taken.map((t) => `${t.weeklySlotId}_${t.startsAt.getTime()}`));
  const slots = [...ctx.weeklySlots].filter((s) => s.isActive).sort((a, b) => a.id.localeCompare(b.id));

  return occurrences.map((occ) => {
    const candidates = slots.filter(
      (s) => s.dayOfWeek === occ.weekday && hourChunks(s.startTime, s.endTime).some((c) => c.chunkStart === occ.time),
    );
    const free = candidates.find((s) => !takenKeys.has(`${s.id}_${occ.startsAt.getTime()}`));
    const chosen = free ?? candidates[0] ?? null;
    const base = {
      ...occ,
      weeklySlotId: chosen ? chosen.id : null,
      slotId: chosen ? `${chosen.id}_${occ.dateKey}_${occ.timeKey}` : null,
    };

    let status: OccurrenceStatus;
    if (occ.startsAt <= ctx.now) status = "in_past";
    else if (candidates.length === 0) status = "no_slot";
    else if (ctx.blocked.some((b) => overlaps(occ.startsAt, occ.endsAt, b.startsAt, b.endsAt))) status = "blocked";
    else if (!free) status = "slot_taken";
    else if (ctx.studentBookings.some((b) => overlaps(occ.startsAt, occ.endsAt, b.startsAt, b.endsAt))) status = "student_busy";
    else status = "ok";
    return { ...base, status };
  });
}

export type CreditAllocation =
  | { creditId: string }
  | { creditId: null; reason: "after_credit_expiry" | "no_credits" };

/**
 * Which credit block pays for each occurrence, in the order given (chronological). Per occurrence:
 * the earliest-expiring usable block with credit left that COVERS that occurrence's date
 * (pickCreditBlockForDate), over COPIES of the blocks (inputs are never mutated).
 *  - `after_credit_expiry`: spendable credit remains, but every such block expires before the class;
 *  - `no_credits`: no spendable credit remains at all (the balance is simply too small).
 */
export function allocateCreditsByDate<T extends CreditBlockLike & { id: string }>(
  blocks: readonly T[],
  startsAts: readonly Date[],
  now: Date,
): CreditAllocation[] {
  const working = blocks.map((b) => ({ ...b }));
  return startsAts.map((startsAt) => {
    const picked = pickCreditBlockForDate(working, now, startsAt);
    if (picked.ok) {
      picked.block.usedCredits += 1;
      return { creditId: picked.block.id };
    }
    return { creditId: null, reason: picked.reason === "no_usable" ? "no_credits" : "after_credit_expiry" };
  });
}

/**
 * Adds the credit-expiry rule on top of classifyOccurrences: every occurrence that would be `ok`
 * is matched to the block that pays for it (chronologically); those no block covers become
 * `after_credit_expiry` (a conflict like any other). `creditByStart` maps the startsAt epoch ms of
 * each funded occurrence to its block; `unfunded` counts the `ok` occurrences left without credit
 * because the balance ran out (the INSUFFICIENT_CREDITS case, not a date problem).
 */
export function applyCreditCoverage<T extends CreditBlockLike & { id: string }>(
  occurrences: readonly ClassifiedOccurrence[],
  blocks: readonly T[],
  now: Date,
): { occurrences: ClassifiedOccurrence[]; creditByStart: Map<number, string>; unfunded: number } {
  const oks = occurrences.filter((o) => o.status === "ok").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const allocation = allocateCreditsByDate(blocks, oks.map((o) => o.startsAt), now);
  const creditByStart = new Map<number, string>();
  const expired = new Set<number>();
  let unfunded = 0;
  oks.forEach((o, i) => {
    const a = allocation[i];
    if (a.creditId !== null) creditByStart.set(o.startsAt.getTime(), a.creditId);
    else if (a.reason === "after_credit_expiry") expired.add(o.startsAt.getTime());
    else unfunded += 1;
  });
  return {
    occurrences: occurrences.map((o) => (expired.has(o.startsAt.getTime()) && o.status === "ok" ? { ...o, status: "after_credit_expiry" as const } : o)),
    creditByStart,
    unfunded,
  };
}

/** Splits a request body into the rule (validated) and the `skipConflicts` flag (default false). */
export function splitSeriesRequest(body: unknown): { rule: SeriesRule; skipConflicts: boolean } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object");
  }
  const { skipConflicts, ...rest } = body as Record<string, unknown>;
  if (skipConflicts !== undefined && typeof skipConflicts !== "boolean") {
    throw new AppError(400, "VALIDATION_ERROR", "skipConflicts must be a boolean");
  }
  return { rule: validateSeriesRule(rest), skipConflicts: skipConflicts === true };
}

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validates the optional `Idempotency-Key` header value. Absent -> undefined; invalid -> 400. */
export function parseIdempotencyKey(header: unknown): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== "string" || !IDEMPOTENCY_KEY_RE.test(header)) {
    throw new AppError(400, "VALIDATION_ERROR", "Idempotency-Key must be 8-128 characters of A-Z, a-z, 0-9, _ or -");
  }
  return header;
}

/**
 * Stable hash of what a request asks for: the validated rule (pattern order is irrelevant) plus
 * skipConflicts. Two bodies that create the same series have the same fingerprint, whatever their
 * JSON key order or an explicit `skipConflicts: false`.
 */
export function seriesFingerprint(rule: SeriesRule, skipConflicts: boolean): string {
  const pattern = [...rule.pattern].sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time));
  const canonical = JSON.stringify({
    pattern: pattern.map((p) => [p.weekday, p.time]),
    intervalWeeks: rule.intervalWeeks,
    startDate: rule.startDate,
    occurrences: rule.occurrences,
    skipConflicts,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
