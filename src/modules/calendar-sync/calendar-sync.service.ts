import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts } from "../../db/schema/users.js";
import { blockedSlots, bookings } from "../../db/schema/scheduling.js";
import { CalDavFetchError, fetchCalendarData } from "./caldav-report.js";
import { calendarSyncEnabled, resolveSyncConfig, type CalendarSyncConfig } from "./config.js";
import { CalendarParseError, mergeIntervals, parseCalendarData, type BusyInterval } from "./ics.js";
import { maskSummary, planSync } from "./sync-plan.js";

/** The constant stored as `reason` on every mirrored row. The event title lives in external_summary (admin-only). */
export const CALDAV_BLOCK_REASON = "nextcloud";

const WEEK_MS = 7 * 24 * 3_600_000;

export type SyncErrorKind = "http" | "network" | "malformed_response" | "config" | "unexpected";

export interface MaskedInterval {
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** First two characters + "***". */
  summary: string | null;
}

export interface SyncSummary {
  dryRun: boolean;
  /** Calendar resources returned by the server. */
  fetched: number;
  /** Distinct busy intervals found (one per event instance). */
  busyIntervals: number;
  /** In a dry run these three are what a real pass WOULD do. */
  inserted: number;
  updated: number;
  deleted: number;
  skippedPlatformEvents: number;
  skippedTransparent: number;
  skippedCancelled: number;
  skippedAllDay: number;
  skippedZeroLength: number;
  skippedInvalid: number;
  failed: boolean;
  error?: { kind: SyncErrorKind; status?: number; code?: string };
  /** Dry run only: the intervals that would be written, titles masked. */
  intervals?: MaskedInterval[];
  /** Dry run only: the union of those intervals, i.e. the time students lose. */
  blockedWindows?: Array<{ startsAt: string; endsAt: string }>;
}

export interface RunOptions {
  now?: Date;
  dryRun?: boolean;
  trigger?: "cron" | "manual";
  /** Overrides on top of the environment (tests). */
  config?: Partial<CalendarSyncConfig>;
  fetchImpl?: typeof fetch;
}

// ---------- in-memory status (per process; the rows themselves are the durable state) ----------

export interface RunRecord {
  at: string;
  trigger: "cron" | "manual";
  dryRun: boolean;
  failed: boolean;
  summary: Omit<SyncSummary, "intervals" | "blockedWindows">;
}

let lastRun: RunRecord | null = null;
let lastDryRun: RunRecord | null = null;

function record(now: Date, trigger: "cron" | "manual", summary: SyncSummary): void {
  const { intervals: _i, blockedWindows: _w, ...counters } = summary;
  const entry: RunRecord = { at: now.toISOString(), trigger, dryRun: summary.dryRun, failed: summary.failed, summary: counters };
  if (summary.dryRun) lastDryRun = entry;
  else lastRun = entry;
}

function blankSummary(dryRun: boolean): SyncSummary {
  return {
    dryRun,
    fetched: 0,
    busyIntervals: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skippedPlatformEvents: 0,
    skippedTransparent: 0,
    skippedCancelled: 0,
    skippedAllDay: 0,
    skippedZeroLength: 0,
    skippedInvalid: 0,
    failed: false,
  };
}

function failure(dryRun: boolean, error: NonNullable<SyncSummary["error"]>): SyncSummary {
  return { ...blankSummary(dryRun), failed: true, error };
}

// ---------- the pass ----------

/**
 * One sync pass: REPORT the calendar, compute the busy intervals, and reconcile the source='caldav' rows of
 * scheduling.blocked_slots in ONE transaction. Manual rows are never read or written. A failed fetch keeps
 * the last known good rows and returns `failed: true`: a failed pass must never un-block anything.
 * Nothing sensitive is logged: no response body, credentials, URLs or event titles.
 */
export async function runCalDavSync(fastify: FastifyInstance, options: RunOptions = {}): Promise<SyncSummary> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const trigger = options.trigger ?? "manual";
  const done = (summary: SyncSummary) => {
    record(now, trigger, summary);
    return summary;
  };

  let config: CalendarSyncConfig;
  try {
    config = { ...resolveSyncConfig(), ...options.config };
  } catch (err) {
    fastify.log.warn({ errName: (err as Error).name }, "calendar-sync: pass failed (configuration)");
    return done(failure(dryRun, { kind: "config" }));
  }

  const window = { start: now, end: new Date(now.getTime() + config.horizonWeeks * WEEK_MS) };

  let resources: string[];
  try {
    resources = await fetchCalendarData(config, window, { expand: config.expand, fetchImpl: options.fetchImpl });
  } catch (err) {
    if (err instanceof CalDavFetchError) {
      fastify.log.warn({ kind: err.kind, status: err.status, code: err.code }, "calendar-sync: pass failed (fetch), keeping last known blocks");
      return done(failure(dryRun, { kind: err.kind, status: err.status, code: err.code }));
    }
    fastify.log.warn({ errName: (err as Error)?.name }, "calendar-sync: pass failed (unexpected), keeping last known blocks");
    return done(failure(dryRun, { kind: "unexpected" }));
  }

  // ---- parse
  const summary = blankSummary(dryRun);
  summary.fetched = resources.length;
  const found = new Map<string, BusyInterval>();
  let unparsable = 0;
  for (const ics of resources) {
    try {
      const parsed = parseCalendarData(ics, { windowStart: window.start, windowEnd: window.end, allDayBlocks: config.allDayBlocks });
      for (const k of Object.keys(parsed.stats) as Array<keyof typeof parsed.stats>) summary[k] += parsed.stats[k];
      for (const interval of parsed.intervals) {
        const prev = found.get(interval.key);
        if (!prev || interval.endsAt > prev.endsAt) found.set(interval.key, interval);
      }
    } catch (err) {
      if (!(err instanceof CalendarParseError)) throw err;
      unparsable++;
      summary.skippedInvalid++;
    }
  }
  if (resources.length > 0 && unparsable === resources.length) {
    // Nothing usable came back: treat it like a failure so the rows (and the blocks) stay.
    fastify.log.warn({ resources: resources.length }, "calendar-sync: pass failed (no resource could be parsed), keeping last known blocks");
    return done({ ...failure(dryRun, { kind: "malformed_response" }), fetched: resources.length, skippedInvalid: unparsable });
  }
  const intervals = [...found.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.key.localeCompare(b.key));
  summary.busyIntervals = intervals.length;

  // ---- reconcile
  try {
    const counts = await fastify.drizzle.transaction(async (tx) => {
      // One reconciliation at a time (cron tick vs. manual run, or two instances).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('calendar-sync'))`);

      const existing = await tx
        .select({
          id: blockedSlots.id,
          externalKey: blockedSlots.externalKey,
          startsAt: blockedSlots.startsAt,
          endsAt: blockedSlots.endsAt,
          externalSummary: blockedSlots.externalSummary,
        })
        .from(blockedSlots)
        .where(eq(blockedSlots.source, "caldav"));
      const plan = planSync(
        existing.filter((e): e is typeof e & { externalKey: string } => e.externalKey !== null),
        intervals,
        window,
      );

      if (!dryRun) {
        if (plan.insert.length) {
          await tx
            .insert(blockedSlots)
            .values(
              plan.insert.map((i) => ({
                teacherId: config.teacherId,
                startsAt: i.startsAt,
                endsAt: i.endsAt,
                reason: CALDAV_BLOCK_REASON,
                source: "caldav",
                externalKey: i.key,
                externalSummary: i.summary,
                syncedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [blockedSlots.source, blockedSlots.externalKey],
              targetWhere: sql`${blockedSlots.source} = 'caldav'`,
              set: {
                startsAt: sql`excluded.starts_at`,
                endsAt: sql`excluded.ends_at`,
                externalSummary: sql`excluded.external_summary`,
                syncedAt: now,
              },
            });
        }
        for (const u of plan.update) {
          await tx
            .update(blockedSlots)
            .set({ startsAt: u.interval.startsAt, endsAt: u.interval.endsAt, externalSummary: u.interval.summary, syncedAt: now })
            .where(eq(blockedSlots.id, u.id));
        }
        if (plan.unchanged.length) await tx.update(blockedSlots).set({ syncedAt: now }).where(inArray(blockedSlots.id, plan.unchanged));
        if (plan.remove.length) await tx.delete(blockedSlots).where(and(inArray(blockedSlots.id, plan.remove), eq(blockedSlots.source, "caldav")));
      }
      return { inserted: plan.insert.length, updated: plan.update.length, deleted: plan.remove.length };
    });
    Object.assign(summary, counts);
  } catch (err) {
    fastify.log.error({ errName: (err as Error)?.name }, "calendar-sync: pass failed (database), nothing was changed");
    return done({ ...failure(dryRun, { kind: "unexpected" }), fetched: summary.fetched });
  }

  if (dryRun) {
    summary.intervals = intervals.map((i) => ({
      startsAt: i.startsAt.toISOString(),
      endsAt: i.endsAt.toISOString(),
      allDay: i.allDay,
      summary: maskSummary(i.summary),
    }));
    summary.blockedWindows = mergeIntervals(intervals).map((m) => ({ startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString() }));
  }

  fastify.log.info(
    {
      dryRun,
      fetched: summary.fetched,
      busyIntervals: summary.busyIntervals,
      inserted: summary.inserted,
      updated: summary.updated,
      deleted: summary.deleted,
    },
    "calendar-sync: pass finished",
  );
  return done(summary);
}

// ---------- admin read models ----------

export async function getSyncStatus(fastify: FastifyInstance) {
  const [{ count }] = await fastify.drizzle
    .select({ count: sql<number>`count(*)::int` })
    .from(blockedSlots)
    .where(eq(blockedSlots.source, "caldav"));
  let horizonWeeks: number | null = null;
  try {
    horizonWeeks = resolveSyncConfig().horizonWeeks;
  } catch {
    horizonWeeks = null;
  }
  return { enabled: calendarSyncEnabled(process.env), horizonWeeks, lastRun, lastDryRun, caldavRows: count };
}

/**
 * Confirmed future bookings that overlap a mirrored Nextcloud block. Surfaced for the admin to resolve by
 * hand: bookings are never cancelled automatically. Admin-only (it carries the student and the event title).
 */
export async function listCalendarConflicts(fastify: FastifyInstance, now: Date = new Date()) {
  const rows = await fastify.drizzle
    .select({
      bookingId: bookings.id,
      studentId: bookings.studentId,
      studentName: accounts.displayName,
      studentEmail: accounts.email,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      blockId: blockedSlots.id,
      blockStartsAt: blockedSlots.startsAt,
      blockEndsAt: blockedSlots.endsAt,
      blockSummary: blockedSlots.externalSummary,
    })
    .from(bookings)
    .innerJoin(
      blockedSlots,
      and(eq(blockedSlots.source, "caldav"), lt(blockedSlots.startsAt, bookings.endsAt), gt(blockedSlots.endsAt, bookings.startsAt)),
    )
    .innerJoin(accounts, eq(accounts.id, bookings.studentId))
    .where(and(eq(bookings.status, "confirmed"), gt(bookings.endsAt, now)))
    .orderBy(asc(bookings.startsAt), asc(blockedSlots.startsAt));

  const byBooking = new Map<string, any>();
  for (const r of rows) {
    const block = { id: r.blockId, startsAt: r.blockStartsAt, endsAt: r.blockEndsAt, summary: r.blockSummary };
    const entry = byBooking.get(r.bookingId);
    if (entry) {
      entry.blocks.push(block);
    } else {
      byBooking.set(r.bookingId, {
        bookingId: r.bookingId,
        studentId: r.studentId,
        studentName: r.studentName,
        studentEmail: r.studentEmail,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        block,
        blocks: [block],
      });
    }
  }
  return [...byBooking.values()];
}

