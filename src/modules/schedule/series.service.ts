import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { accounts } from "../../db/schema/users.js";
import { products } from "../../db/schema/ecommerce.js";
import { blockedSlots, bookingSeries, bookings, classCredits, weeklySlots } from "../../db/schema/scheduling.js";
import { AppError } from "../../lib/errors.js";
import { normalizeLocale } from "../../lib/locale.js";
import { summarizeBalance } from "./credit-balance.js";
import { DEFAULT_CAMPUS_URL } from "./reminders.service.js";
import {
  buildIcal,
  checkOccurrenceInTx,
  insertBookingInTx,
  lockBookingInstant,
  type DbHandle,
} from "./schedule.service.js";
import {
  allocateCredits,
  classifyOccurrences,
  generateOccurrences,
  validateSeriesRule,
  type ClassifiedOccurrence,
  type OccurrenceStatus,
} from "./series.js";
import { buildSeriesCancellationEmail, buildSeriesConfirmationEmail } from "./student-emails.js";
import "../../plugins/caldav.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Same cutoff as cancelStudentBooking: a student cannot cancel a class that starts within 24h. */
const STUDENT_CANCEL_CUTOFF_MS = DAY_MS;

export interface OccurrenceReport {
  startsAt: string;
  status: OccurrenceStatus;
}

const toReport = (o: ClassifiedOccurrence): OccurrenceReport => ({ startsAt: o.startsAt.toISOString(), status: o.status });

function dashboardUrl(): string {
  return `${(env.campus.origin ?? DEFAULT_CAMPUS_URL).replace(/\/+$/, "")}/dashboard`;
}

async function loadStudent(db: DbHandle, studentId: string) {
  const [student] = await db
    .select({ id: accounts.id, email: accounts.email, displayName: accounts.displayName, locale: accounts.locale, role: accounts.role })
    .from(accounts)
    .where(and(eq(accounts.id, studentId), eq(accounts.isActive, true)))
    .limit(1);
  if (!student || student.role === "admin") throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  return student;
}

/** Loads what classifyOccurrences needs for the given occurrences. Works on the pool or a transaction. */
async function classify(db: DbHandle, studentId: string, occurrences: ReturnType<typeof generateOccurrences>, now: Date) {
  const first = occurrences[0].startsAt;
  const last = occurrences[occurrences.length - 1].endsAt;

  const slots = await db
    .select({ id: weeklySlots.id, dayOfWeek: weeklySlots.dayOfWeek, startTime: weeklySlots.startTime, endTime: weeklySlots.endTime, isActive: weeklySlots.isActive })
    .from(weeklySlots)
    .where(eq(weeklySlots.isActive, true));

  const active = and(
    sql`${bookings.status} IN ('confirmed', 'pending')`,
    sql`${bookings.startsAt} < ${last}`,
    sql`${bookings.endsAt} > ${first}`,
  );
  const taken = await db
    .select({ weeklySlotId: bookings.weeklySlotId, startsAt: bookings.startsAt })
    .from(bookings)
    .where(and(active, sql`${bookings.weeklySlotId} IS NOT NULL`));
  const mine = await db
    .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(and(active, eq(bookings.studentId, studentId)));
  const blocked = await db
    .select({ startsAt: blockedSlots.startsAt, endsAt: blockedSlots.endsAt })
    .from(blockedSlots)
    .where(and(sql`${blockedSlots.startsAt} < ${last}`, sql`${blockedSlots.endsAt} > ${first}`));

  return classifyOccurrences(occurrences, { weeklySlots: slots, taken, blocked, studentBookings: mine, now });
}

async function studentBalance(db: DbHandle, studentId: string, now: Date): Promise<number> {
  const rows = await db
    .select({
      creditId: classCredits.id,
      productName: products.name,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      expiresAt: classCredits.expiresAt,
      createdAt: classCredits.createdAt,
    })
    .from(classCredits)
    .innerJoin(products, eq(classCredits.productId, products.id))
    .where(eq(classCredits.userId, studentId));
  return summarizeBalance(rows, now).balance;
}

// ---------------------------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------------------------

export async function previewSeries(fastify: FastifyInstance, params: { studentId: string; rule: unknown }) {
  const now = new Date();
  const rule = validateSeriesRule(params.rule);
  await loadStudent(fastify.drizzle, params.studentId);
  const occurrences = generateOccurrences(rule, now);
  const classified = await classify(fastify.drizzle, params.studentId, occurrences, now);
  const required = classified.filter((o) => o.status === "ok").length;
  const balance = await studentBalance(fastify.drizzle, params.studentId, now);
  return {
    requested: rule.occurrences,
    occurrences: classified.map(toReport),
    required,
    balance,
    sufficientCredits: required <= balance,
  };
}

// ---------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------

/**
 * Creates a series in ONE transaction:
 *   lock the student's credit blocks -> lock every instant (ascending) -> classify with fresh data
 *   -> conflicts? (409 unless skipConflicts) -> enough credits? (409) -> insert the series row and
 *   one booking per ok occurrence, each charged to its own block (allocateCredits).
 * CalDAV events and the single summary email happen after commit and are best-effort.
 *
 * Order of the two 409s: conflicts are reported before credits (with skipConflicts=false the
 * balance is irrelevant if nothing can be created anyway).
 */
export async function createSeries(
  fastify: FastifyInstance,
  params: { studentId: string; createdBy: string; rule: unknown; skipConflicts?: boolean },
) {
  const { studentId, createdBy, skipConflicts = false } = params;
  const rule = validateSeriesRule(params.rule);
  const student = await loadStudent(fastify.drizzle, studentId);

  const committed = await fastify.drizzle.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbHandle;
    const now = new Date();
    const occurrences = generateOccurrences(rule, now);

    // Same lock order as single bookings: credits first, then instants.
    const blocks = await tx
      .select()
      .from(classCredits)
      .where(eq(classCredits.userId, studentId))
      .orderBy(asc(classCredits.createdAt))
      .for("update");
    for (const occ of [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
      await lockBookingInstant(tx, occ.startsAt);
    }

    const classified = await classify(tx, studentId, occurrences, now);
    const conflicts = classified.filter((o) => o.status !== "ok");
    if (conflicts.length > 0 && (!skipConflicts || conflicts.length === classified.length)) {
      throw new AppError(409, "SERIES_CONFLICTS", "Some occurrences cannot be booked", { occurrences: classified.map(toReport) });
    }

    const okOccurrences = classified.filter((o) => o.status === "ok");
    const balance = summarizeBalance(
      blocks.map((b) => ({ ...b, creditId: b.id, productName: "" })),
      now,
    ).balance;
    const allocation = allocateCredits(blocks, okOccurrences.length, now);
    if (!allocation.complete) {
      throw new AppError(409, "INSUFFICIENT_CREDITS", "Not enough credits for this series", { required: okOccurrences.length, balance });
    }
    const blockById = new Map(blocks.map((b) => [b.id, b]));

    const [series] = await tx
      .insert(bookingSeries)
      .values({
        studentId,
        createdBy,
        pattern: rule.pattern,
        intervalWeeks: rule.intervalWeeks,
        startDate: rule.startDate,
        requestedOccurrences: rule.occurrences,
        createdOccurrences: 0,
      })
      .returning({ id: bookingSeries.id });

    // Authoritative re-check with the same function single bookings use, then insert.
    const created: Array<{ bookingId: string; startsAt: Date; endsAt: Date; meetLink: string; productId: string }> = [];
    const skipped: OccurrenceReport[] = conflicts.map(toReport);
    for (const occ of okOccurrences) {
      const target = { weeklySlotId: occ.weeklySlotId!, availabilityId: null, startsAt: occ.startsAt, endsAt: occ.endsAt };
      const conflict = await checkOccurrenceInTx(tx, { studentId, target });
      if (conflict) {
        if (!skipConflicts) {
          throw new AppError(409, "SERIES_CONFLICTS", "Some occurrences cannot be booked", {
            occurrences: classified.map((c) => (c === occ ? { startsAt: c.startsAt.toISOString(), status: conflict } : toReport(c))),
          });
        }
        skipped.push({ startsAt: occ.startsAt.toISOString(), status: conflict });
        continue;
      }
      const block = blockById.get(allocation.creditIds[created.length])!;
      const { bookingId, meetLink } = await insertBookingInTx(tx, {
        studentId,
        target,
        credit: { id: block.id, productId: block.productId },
        consumeCredit: true,
        seriesId: series.id,
      });
      created.push({ bookingId, startsAt: occ.startsAt, endsAt: occ.endsAt, meetLink, productId: block.productId });
    }

    if (created.length === 0) {
      throw new AppError(409, "SERIES_CONFLICTS", "Some occurrences cannot be booked", { occurrences: classified.map(toReport) });
    }
    await tx.update(bookingSeries).set({ createdOccurrences: created.length }).where(eq(bookingSeries.id, series.id));

    skipped.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { seriesId: series.id, created, skipped, balanceAfter: balance - created.length };
  });

  const { seriesId, created, skipped, balanceAfter } = committed;

  // ---- after commit: best-effort side effects ------------------------------------------------
  const productNames = new Map<string, string>();
  const productIds = [...new Set(created.map((c) => c.productId))];
  if (productIds.length) {
    const rows = await fastify.drizzle.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds));
    for (const r of rows) productNames.set(r.id, r.name);
  }

  for (const c of created) {
    try {
      await fastify.caldav.createEvent(
        c.bookingId,
        buildIcal({
          uid: c.bookingId,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          summary: `Clase — ${productNames.get(c.productId) ?? "English"} · ${student.displayName}`,
          description: c.meetLink,
          location: c.meetLink,
          attendeeEmail: student.email,
        }),
      );
      await fastify.drizzle.update(bookings).set({ gcalEventId: c.bookingId }).where(eq(bookings.id, c.bookingId));
    } catch (err) {
      fastify.log.error({ err }, "Failed to create CalDAV event for series occurrence");
    }
  }

  try {
    const mail = buildSeriesConfirmationEmail({
      locale: normalizeLocale(student.locale),
      studentName: student.displayName,
      dates: created.map((c) => c.startsAt),
      creditsUsed: created.length,
      balanceRemaining: balanceAfter,
      dashboardUrl: dashboardUrl(),
    });
    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: student.email,
      subject: mail.subject,
      html: mail.html,
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send series confirmation email");
  }

  return {
    seriesId,
    requested: rule.occurrences,
    created: created.length,
    skipped,
    creditsUsed: created.length,
    balanceAfter,
    bookings: created.map((c) => ({ bookingId: c.bookingId, startsAt: c.startsAt.toISOString(), meetLink: c.meetLink })),
  };
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

export async function listSeries(fastify: FastifyInstance, studentId: string) {
  const series = await fastify.drizzle
    .select()
    .from(bookingSeries)
    .where(eq(bookingSeries.studentId, studentId))
    .orderBy(desc(bookingSeries.createdAt));
  if (series.length === 0) return [];

  const rows = await fastify.drizzle
    .select({ id: bookings.id, seriesId: bookings.seriesId, startsAt: bookings.startsAt, status: bookings.status, meetLink: bookings.meetLink })
    .from(bookings)
    .where(inArray(bookings.seriesId, series.map((s) => s.id)))
    .orderBy(asc(bookings.startsAt));

  return series.map((s) => ({
    id: s.id,
    status: s.status,
    pattern: s.pattern as Array<{ weekday: number; time: string }>,
    intervalWeeks: s.intervalWeeks,
    startDate: s.startDate,
    requestedOccurrences: s.requestedOccurrences,
    createdOccurrences: s.createdOccurrences,
    createdAt: s.createdAt.toISOString(),
    occurrences: rows
      .filter((r) => r.seriesId === s.id)
      .map((r) => ({ bookingId: r.id, startsAt: r.startsAt.toISOString(), status: r.status, meetLink: r.meetLink })),
  }));
}

// ---------------------------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------------------------

export type SeriesActor = { role: "student"; userId: string } | { role: "admin" };

/**
 * Cancels the future occurrences of a series (starts_at > now), refunding 1 credit per cancelled
 * booking to the block that paid for it. A student keeps occurrences starting within 24h (reported
 * as `kept`); an admin has no cutoff. The series becomes `cancelled` once no future confirmed or
 * pending occurrence is left. Idempotent: a second call finds nothing to cancel.
 */
export async function cancelSeries(fastify: FastifyInstance, params: { seriesId: string; actor: SeriesActor }) {
  const { seriesId, actor } = params;

  const result = await fastify.drizzle.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbHandle;
    const now = new Date();

    const [series] = await tx
      .select()
      .from(bookingSeries)
      .where(
        actor.role === "student"
          ? and(eq(bookingSeries.id, seriesId), eq(bookingSeries.studentId, actor.userId))
          : eq(bookingSeries.id, seriesId),
      )
      .for("update");
    if (!series) throw new AppError(404, "NOT_FOUND", "Series not found");

    const future = await tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.seriesId, seriesId),
          sql`${bookings.status} IN ('confirmed', 'pending')`,
          gt(bookings.startsAt, now),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .for("update");

    const cutoff = now.getTime() + STUDENT_CANCEL_CUTOFF_MS;
    const kept = actor.role === "student" ? future.filter((b) => b.startsAt.getTime() <= cutoff) : [];
    const keptIds = new Set(kept.map((b) => b.id));
    const toCancel = future.filter((b) => !keptIds.has(b.id));

    const cancelled =
      toCancel.length === 0
        ? []
        : await tx
            .update(bookings)
            .set({
              status: "cancelled",
              cancelledAt: now,
              cancelReason: actor.role === "student" ? "Series cancelled by student" : "Series cancelled by admin",
              updatedAt: now,
            })
            .where(
              and(
                inArray(bookings.id, toCancel.map((b) => b.id)),
                sql`${bookings.status} IN ('confirmed', 'pending')`,
              ),
            )
            .returning({ id: bookings.id, creditId: bookings.creditId, startsAt: bookings.startsAt, gcalEventId: bookings.gcalEventId });

    const refundByBlock = new Map<string, number>();
    for (const b of cancelled) refundByBlock.set(b.creditId, (refundByBlock.get(b.creditId) ?? 0) + 1);
    for (const [creditId, n] of refundByBlock) {
      await tx
        .update(classCredits)
        .set({ usedCredits: sql`GREATEST(${classCredits.usedCredits} - ${n}, 0)` })
        .where(eq(classCredits.id, creditId));
    }

    let status = series.status;
    if (kept.length === 0 && status !== "cancelled") {
      await tx.update(bookingSeries).set({ status: "cancelled" }).where(eq(bookingSeries.id, seriesId));
      status = "cancelled";
    }

    return { series, cancelled, kept, status };
  });

  const { series, cancelled, kept, status } = result;

  for (const b of cancelled) {
    if (!b.gcalEventId) continue;
    try {
      await fastify.caldav.deleteEvent(b.gcalEventId);
    } catch (err) {
      fastify.log.error({ err }, "Failed to delete CalDAV event for series occurrence");
    }
  }

  if (cancelled.length > 0) {
    try {
      const [student] = await fastify.drizzle
        .select({ email: accounts.email, displayName: accounts.displayName, locale: accounts.locale })
        .from(accounts)
        .where(eq(accounts.id, series.studentId))
        .limit(1);
      if (student) {
        const mail = buildSeriesCancellationEmail({
          locale: normalizeLocale(student.locale),
          studentName: student.displayName,
          cancelledDates: cancelled.map((b) => b.startsAt),
          keptDates: kept.map((b) => b.startsAt),
          creditsRefunded: cancelled.length,
          dashboardUrl: dashboardUrl(),
        });
        await fastify.mailer.sendMail({
          from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
          to: student.email,
          subject: mail.subject,
          html: mail.html,
        });
      }
    } catch (err) {
      fastify.log.error({ err }, "Failed to send series cancellation email");
    }
  }

  return {
    seriesId,
    status,
    cancelled: cancelled.length,
    refunded: cancelled.length,
    kept: kept.map((b) => ({ bookingId: b.id, startsAt: b.startsAt.toISOString() })),
  };
}
