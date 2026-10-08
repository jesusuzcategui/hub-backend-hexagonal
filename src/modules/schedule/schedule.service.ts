import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { env } from "../../config/env.js";
import { accounts } from "../../db/schema/users.js";
import { products } from "../../db/schema/ecommerce.js";
import * as schema from "../../db/schema/index.js";
import { availabilities, blockedSlots, bookings, classCredits, weeklySlots } from "../../db/schema/scheduling.js";
import { escapeHtml } from "../payments/payments.service.js";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template.js";
import { AppError } from "../../lib/errors.js";
import { buildBookingConfirmedEmail } from "./student-emails.js";
import { coversClassDate, isUsableBlock, pickCreditBlockForDate, summarizeBalance, type BalanceSummary } from "./credit-balance.js";
import { hourChunks, pad2 } from "./slot-time.js";
import "../../plugins/caldav.js";

function icalDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icalEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function buildIcal({
  uid,
  startsAt,
  endsAt,
  summary,
  description,
  location,
  attendeeEmail,
  method,
}: {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string;
  location?: string;
  attendeeEmail?: string;
  method?: "REQUEST";
}): string {
  const now = icalDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method ? [`METHOD:${method}`] : []),
    "PRODID:-//Hub Vanjex//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}@vanjex.dev`,
    `DTSTAMP:${now}`,
    `DTSTART:${icalDate(startsAt)}`,
    `DTEND:${icalDate(endsAt)}`,
    `SUMMARY:${icalEscape(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icalEscape(description)}`);
  if (location) lines.push(`LOCATION:${icalEscape(location)}`);
  lines.push(`ORGANIZER;CN=${icalEscape(env.smtp.fromName)}:mailto:${env.smtp.from}`);
  if (attendeeEmail) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// Generate upcoming 1-hour slot instances for a weekly slot (Colombia time = UTC-5)
function upcomingOccurrences(dayOfWeek: number, startTime: string, endTime: string, weeks = 6) {
  const now = new Date();
  const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = bogotaFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const nowBogotaH = parseInt(get("hour") === "24" ? "0" : get("hour"));
  const nowBogotaM = parseInt(get("minute"));
  const todayBogota = new Date(parseInt(get("year")), parseInt(get("month")) - 1, parseInt(get("day")));
  const todayDow = todayBogota.getDay();

  const chunks = hourChunks(startTime, endTime);
  const results: Array<{ slotDate: string; chunkHHMM: string; startsAt: Date; endsAt: Date }> = [];

  for (let w = 0; w < weeks; w++) {
    let daysUntil = (dayOfWeek - todayDow + 7) % 7 + w * 7;
    if (daysUntil === 0 && w === 0) daysUntil = 0; // same day handled per-chunk below

    const target = new Date(todayBogota);
    target.setDate(todayBogota.getDate() + daysUntil);
    const y = target.getFullYear();
    const mo = pad2(target.getMonth() + 1);
    const d = pad2(target.getDate());
    const slotDate = `${y}${mo}${d}`;

    for (const { chunkStart, chunkEnd } of chunks) {
      const [ch, cm] = chunkStart.split(":").map(Number);
      // Skip if same day and this chunk already passed
      if (daysUntil === 0 && w === 0 && (ch < nowBogotaH || (ch === nowBogotaH && cm <= nowBogotaM))) {
        continue;
      }
      const startsAt = new Date(`${y}-${mo}-${d}T${chunkStart}:00-05:00`);
      const endsAt = new Date(`${y}-${mo}-${d}T${chunkEnd}:00-05:00`);
      results.push({ slotDate, chunkHHMM: chunkStart.replace(":", ""), startsAt, endsAt });
    }
  }

  return results;
}

export async function getAvailableSlots(fastify: FastifyInstance) {
  const slots = await fastify.drizzle
    .select({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
    })
    .from(weeklySlots)
    .where(eq(weeklySlots.isActive, true));

  if (slots.length === 0) return [];

  // Find all future bookings on weekly slots (confirmed/pending) to know which are taken
  const takenBookings = await fastify.drizzle
    .select({
      weeklySlotId: bookings.weeklySlotId,
      startsAt: bookings.startsAt,
    })
    .from(bookings)
    .where(
      and(
        gt(bookings.startsAt, new Date()),
        sql`${bookings.status} IN ('confirmed', 'pending')`,
        isNull(bookings.availabilityId),
      ),
    );

  // takenKey format: weeklySlotId_YYYYMMDD_HHMM (startsAt in Bogotá time)
  const takenKeys = new Set(
    takenBookings.map((b) => {
      // Convert UTC startsAt → Bogotá date+time for key
      const iso = b.startsAt.toISOString(); // e.g. 2026-06-16T15:00:00.000Z = 10:00 COT
      const bogota = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(iso));
      const gp = (type: string) => bogota.find((p) => p.type === type)?.value ?? "0";
      const dateKey = `${gp("year")}${gp("month")}${gp("day")}`;
      const h = gp("hour") === "24" ? "00" : gp("hour");
      const timeKey = `${h}${gp("minute")}`;
      return `${b.weeklySlotId}_${dateKey}_${timeKey}`;
    }),
  );

  const blocks = await fastify.drizzle
    .select({ startsAt: blockedSlots.startsAt, endsAt: blockedSlots.endsAt })
    .from(blockedSlots)
    .where(gt(blockedSlots.endsAt, new Date()));

  const overlapsBlock = (startsAt: Date, endsAt: Date) =>
    blocks.some((b) => startsAt < b.endsAt && endsAt > b.startsAt);

  const available: Array<{ id: string; startsAt: string; endsAt: string }> = [];

  for (const slot of slots) {
    const occurrences = upcomingOccurrences(slot.dayOfWeek, slot.startTime, slot.endTime, 6);
    for (const occ of occurrences) {
      const key = `${slot.id}_${occ.slotDate}_${occ.chunkHHMM}`;
      if (!takenKeys.has(key) && !overlapsBlock(occ.startsAt, occ.endsAt)) {
        available.push({
          id: key,
          startsAt: occ.startsAt.toISOString(),
          endsAt: occ.endsAt.toISOString(),
        });
      }
    }
  }

  return available.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export type StudentCreditSummary = BalanceSummary & {
  /** Same entries as `blocks`, plus the productId the legacy campus payload carried. */
  blocks: Array<BalanceSummary["blocks"][number] & { productId: string }>;
};

/** One balance per student: remaining credits summed over their non-expired blocks. */
export async function getStudentCredits(fastify: FastifyInstance, userId: string): Promise<StudentCreditSummary> {
  const rows = await fastify.drizzle
    .select({
      creditId: classCredits.id,
      productId: classCredits.productId,
      productName: products.name,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      expiresAt: classCredits.expiresAt,
      createdAt: classCredits.createdAt,
    })
    .from(classCredits)
    .innerJoin(products, eq(classCredits.productId, products.id))
    .where(eq(classCredits.userId, userId));

  const summary = summarizeBalance(rows, new Date());
  const productByCredit = new Map(rows.map((r) => [r.creditId, r.productId]));
  return {
    ...summary,
    blocks: summary.blocks.map((b) => ({ ...b, productId: productByCredit.get(b.creditId)! })),
  };
}


/** A drizzle handle: the pool-backed db or a transaction opened by the caller. */
export type DbHandle = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export type BookingConflict = "blocked" | "slot_taken" | "student_busy";

export interface BookingTarget {
  weeklySlotId: string | null;
  availabilityId: string | null;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Serializes everything that books the same instant. Bookings have no unique constraint (a weekly
 * slot is a rule, not a row), so "check then insert" would race without it. Transaction-scoped and
 * re-entrant: calling it twice in one transaction is a no-op. Callers that lock several instants
 * must do it in ascending time order to avoid deadlocks.
 */
export async function lockBookingInstant(tx: DbHandle, startsAt: Date): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-instant:${startsAt.getTime()}`}))`);
}

/**
 * Per-occurrence availability checks, shared by single bookings and series. Must run inside the
 * caller's transaction. Returns the first conflict found, or null when the occurrence is free.
 * Side effect for legacy availability slots: marks the availability as booked (rolled back with
 * the transaction if anything later fails).
 */
export async function checkOccurrenceInTx(
  tx: DbHandle,
  params: { studentId: string; target: BookingTarget; replacesBookingId?: string },
): Promise<BookingConflict | null> {
  const { studentId, target, replacesBookingId } = params;
  const { weeklySlotId, availabilityId, startsAt, endsAt } = target;

  await lockBookingInstant(tx, startsAt);

  const [block] = await tx
    .select({ id: blockedSlots.id })
    .from(blockedSlots)
    .where(and(sql`${blockedSlots.startsAt} < ${endsAt}`, sql`${blockedSlots.endsAt} > ${startsAt}`))
    .limit(1);
  if (block) return "blocked";

  if (weeklySlotId) {
    // Someone else booking the same weekly slot + date
    const [existing] = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.weeklySlotId, weeklySlotId),
          eq(bookings.startsAt, startsAt),
          sql`${bookings.status} IN ('confirmed', 'pending')`,
        ),
      )
      .for("update")
      .limit(1);
    if (existing) return "slot_taken";
  } else if (availabilityId) {
    const [slot] = await tx
      .select({ isBooked: availabilities.isBooked })
      .from(availabilities)
      .where(eq(availabilities.id, availabilityId))
      .for("update");
    if (!slot || slot.isBooked) return "slot_taken";
    await tx.update(availabilities).set({ isBooked: true }).where(eq(availabilities.id, availabilityId));
  }

  const [busy] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.studentId, studentId),
        sql`${bookings.status} IN ('confirmed', 'pending')`,
        sql`${bookings.startsAt} < ${endsAt}`,
        sql`${bookings.endsAt} > ${startsAt}`,
        ...(replacesBookingId ? [ne(bookings.id, replacesBookingId)] : []),
      ),
    )
    .limit(1);
  if (busy) return "student_busy";

  return null;
}

/**
 * Inserts one confirmed booking charged to `credit` (and, when `consumeCredit`, deducts 1 from that
 * block, guarded so a block can never go over its total). Runs inside the caller's transaction.
 */
export async function insertBookingInTx(
  tx: DbHandle,
  params: {
    studentId: string;
    target: BookingTarget;
    credit: { id: string; productId: string };
    consumeCredit: boolean;
    notes?: string | null;
    seriesId?: string | null;
  },
): Promise<{ bookingId: string; meetLink: string }> {
  const { studentId, target, credit, consumeCredit, notes, seriesId } = params;

  if (consumeCredit) {
    const charged = await tx
      .update(classCredits)
      .set({ usedCredits: sql`${classCredits.usedCredits} + 1` })
      .where(and(eq(classCredits.id, credit.id), sql`${classCredits.usedCredits} < ${classCredits.totalCredits}`))
      .returning({ id: classCredits.id });
    if (charged.length === 0) throw new AppError(409, "NO_CREDITS", "No credits remaining");
  }

  const bookingId = randomUUID();
  const meetLink = `${env.jitsi.baseUrl}/clase-${bookingId.replace(/-/g, "")}`;
  await tx.insert(bookings).values({
    id: bookingId,
    studentId,
    creditId: credit.id,
    availabilityId: target.availabilityId,
    weeklySlotId: target.weeklySlotId,
    productId: credit.productId,
    seriesId: seriesId ?? null,
    status: "confirmed",
    startsAt: target.startsAt,
    endsAt: target.endsAt,
    studentNotes: notes ?? null,
    meetLink,
  });
  return { bookingId, meetLink };
}

/**
 * 409 CLASS_AFTER_CREDIT_EXPIRY. `creditExpiresAt` when a specific credit was named (explicit
 * creditId, reschedule); `latestCreditExpiry` when the student has spendable credits but none of
 * them reaches the class date.
 */
export function classAfterCreditExpiry(d: { creditExpiresAt: Date; classStartsAt: Date } | { latestCreditExpiry: Date; classStartsAt: Date }): AppError {
  const details =
    "creditExpiresAt" in d
      ? { creditExpiresAt: d.creditExpiresAt.toISOString(), classStartsAt: d.classStartsAt.toISOString() }
      : { latestCreditExpiry: d.latestCreditExpiry.toISOString(), classStartsAt: d.classStartsAt.toISOString() };
  return new AppError(409, "CLASS_AFTER_CREDIT_EXPIRY", "That class falls after your credits expire. Pick a date on or before the expiry.", details);
}

function conflictToError(conflict: BookingConflict): AppError {
  if (conflict === "blocked") return new AppError(409, "SLOT_BLOCKED", "Slot is blocked");
  if (conflict === "slot_taken") return new AppError(409, "SLOT_TAKEN", "Slot already booked");
  return new AppError(409, "STUDENT_BUSY", "You are already booked at that time");
}

export async function createStudentBooking(
  fastify: FastifyInstance,
  params: {
    studentId: string;
    slotId: string; // composite: weeklySlotId_YYYYMMDD_HHMM OR legacy availabilityId (uuid)
    // Optional: when absent the block that expires first is charged automatically.
    creditId?: string;
    notes?: string;
    // false when this booking is the "new" half of a reschedule — the credit
    // was already consumed by the booking being replaced, so it must not be
    // charged again.
    consumeCredit?: boolean;
    // The booking this one replaces (reschedule): excluded from the student-busy check.
    replacesBookingId?: string;
  },
) {
  const { studentId, slotId, creditId, notes, consumeCredit = true, replacesBookingId } = params;

  const student = await fastify.drizzle
    .select({ id: accounts.id, email: accounts.email, displayName: accounts.displayName, locale: accounts.locale })
    .from(accounts)
    .where(eq(accounts.id, studentId))
    .limit(1);
  if (!student[0]) throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");

  // ID formats: "uuid" (legacy availability) | "uuid_YYYYMMDD_HHMM" (weekly slot chunk)
  const idParts = slotId.split("_");
  const isWeeklySlot = idParts.length >= 3;
  let weeklySlotId: string | null = null;
  let availabilityId: string | null = null;
  let startsAt: Date;
  let endsAt: Date;

  if (isWeeklySlot) {
    weeklySlotId = idParts[0]; // UUID (no underscores)
    const datePart = idParts[1]; // YYYYMMDD
    const timePart = idParts[2]; // HHMM

    const slot = await fastify.drizzle
      .select({
        id: weeklySlots.id,
        dayOfWeek: weeklySlots.dayOfWeek,
        startTime: weeklySlots.startTime,
        endTime: weeklySlots.endTime,
        isActive: weeklySlots.isActive,
      })
      .from(weeklySlots)
      .where(eq(weeklySlots.id, weeklySlotId))
      .limit(1);

    if (!slot[0]) throw new AppError(404, "SLOT_NOT_FOUND", "Weekly slot not found");
    if (!slot[0].isActive) throw new AppError(409, "SLOT_NOT_AVAILABLE", "Weekly slot is not active");

    const y = datePart.substring(0, 4);
    const mo = datePart.substring(4, 6);
    const d = datePart.substring(6, 8);
    const hh = timePart.substring(0, 2);
    const mm = timePart.substring(2, 4);
    const chunkStartHHMM = `${hh}:${mm}`;

    // Validate day-of-week matches the slot definition
    const bogotaDay = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota", weekday: "short",
    }).format(new Date(`${y}-${mo}-${d}T12:00:00-05:00`));
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const suppliedDow = dowMap[bogotaDay] ?? -1;
    if (suppliedDow !== slot[0].dayOfWeek) {
      throw new AppError(400, "INVALID_SLOT", "Invalid slot: date does not match slot day-of-week");
    }

    // Validate the chunk start time is a legitimate hour-chunk of this slot's range
    const validChunks = hourChunks(slot[0].startTime, slot[0].endTime).map((c) => c.chunkStart);
    if (!validChunks.includes(chunkStartHHMM)) {
      throw new AppError(400, "INVALID_SLOT", "Invalid slot: time is not a valid hour chunk of this slot");
    }

    const hEnd = pad2(parseInt(hh) + 1); // always 1-hour slot
    startsAt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:00-05:00`);
    endsAt = new Date(`${y}-${mo}-${d}T${hEnd}:${mm}:00-05:00`);

    if (startsAt <= new Date()) throw new AppError(409, "SLOT_IN_PAST", "Slot is in the past");
  } else {
    availabilityId = slotId;
    const [avail] = await fastify.drizzle
      .select()
      .from(availabilities)
      .where(eq(availabilities.id, slotId))
      .limit(1);
    if (!avail) throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
    if (avail.isBooked) throw new AppError(409, "SLOT_TAKEN", "Slot already booked");
    startsAt = avail.startsAt;
    endsAt = avail.endsAt;
  }

  let bookingId: string;
  let verifiedProductId: string;
  let meetLink: string | null = null;

  await fastify.drizzle.transaction(async (tx) => {
    const target: BookingTarget = { weeklySlotId, availabilityId, startsAt, endsAt };
    const conflict = await checkOccurrenceInTx(tx, { studentId, target, replacesBookingId });
    if (conflict) throw conflictToError(conflict);

    const now = new Date();
    let credit: typeof classCredits.$inferSelect;

    if (creditId) {
      const [explicit] = await tx
        .select()
        .from(classCredits)
        .where(and(eq(classCredits.id, creditId), eq(classCredits.userId, studentId)))
        .for("update");
      if (!explicit) throw new AppError(404, "CREDIT_NOT_FOUND", "Credit not found");
      // consumeCredit=false: this credit was already consumed by the booking
      // being replaced (reschedule) — don't re-check remaining balance or
      // "usable right now" (a class booked while valid is honored) and don't
      // increment again, that would double-charge a single credit.
      if (consumeCredit) {
        if (explicit.usedCredits >= explicit.totalCredits) throw new AppError(409, "NO_CREDITS", "No credits remaining");
        if (!isUsableBlock(explicit, now)) throw new AppError(409, "CREDIT_EXPIRED", "This credit has expired");
      }
      // The class DATE must be on or before the credit's expiry day (Bogota, inclusive). This applies
      // to every path that names a credit, reschedules included: a moved class still lives on the
      // credit that paid for it.
      if (!coversClassDate(explicit, startsAt)) throw classAfterCreditExpiry({ creditExpiresAt: explicit.expiresAt!, classStartsAt: startsAt });
      credit = explicit;
    } else {
      if (!consumeCredit) throw new AppError(400, "MISSING_FIELDS", "creditId is required when not consuming a credit");
      // Lock every block of the student so two concurrent bookings cannot pick the same one.
      const blocksOfStudent = await tx
        .select()
        .from(classCredits)
        .where(eq(classCredits.userId, studentId))
        .orderBy(asc(classCredits.createdAt))
        .for("update");
      // Earliest-expiring usable block with credit whose coverage includes the class date.
      const picked = pickCreditBlockForDate(blocksOfStudent, now, startsAt);
      if (!picked.ok && picked.reason === "after_credit_expiry") {
        throw classAfterCreditExpiry({ latestCreditExpiry: picked.latestCreditExpiry, classStartsAt: startsAt });
      }
      if (!picked.ok) {
        const hasExpiredLeftovers = blocksOfStudent.some((b) => b.usedCredits < b.totalCredits);
        if (hasExpiredLeftovers) throw new AppError(409, "CREDITS_EXPIRED", "Your credits have expired");
        throw new AppError(409, "NO_CREDITS", "No credits remaining");
      }
      credit = picked.block;
    }
    verifiedProductId = credit.productId;

    const inserted = await insertBookingInTx(tx, { studentId, target, credit, consumeCredit, notes });
    bookingId = inserted.bookingId;
    meetLink = inserted.meetLink;
  });

  // Load product name using the credit's verified productId (not client-supplied)
  const [product] = await fastify.drizzle
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, verifiedProductId!))
    .limit(1);

  // Create CalDAV event for admin calendar visibility
  const icalForCalDAV = buildIcal({
    uid: bookingId!,
    startsAt: startsAt!,
    endsAt: endsAt!,
    summary: `Clase — ${product?.name ?? "English"} · ${student[0].displayName}`,
    description: meetLink ?? undefined,
    location: meetLink ?? undefined,
    attendeeEmail: student[0].email,
  });
  try {
    await fastify.caldav.createEvent(bookingId!, icalForCalDAV);
    await fastify.drizzle
      .update(bookings)
      .set({ gcalEventId: bookingId! })
      .where(eq(bookings.id, bookingId!));
  } catch (err) {
    fastify.log.error({ err }, "Failed to create CalDAV event");
  }

  // Send booking confirmation email with calendar invite attachment
  try {
    const icalInvite = buildIcal({
      uid: bookingId!,
      startsAt: startsAt!,
      endsAt: endsAt!,
      summary: `Clase — ${product?.name ?? "English"} · ${student[0].displayName}`,
      description: meetLink ?? undefined,
      location: meetLink ?? undefined,
      attendeeEmail: student[0].email,
      method: "REQUEST",
    });

    const confirmation = buildBookingConfirmedEmail({
      locale: student[0].locale,
      studentName: student[0].displayName,
      productName: product?.name ?? "inglés",
      startsAt: startsAt!,
      meetLink,
    });

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: student[0].email,
      subject: confirmation.subject,
      html: confirmation.html,
      attachments: [
        {
          filename: "clase.ics",
          content: icalInvite,
          contentType: "text/calendar; method=REQUEST; charset=UTF-8",
        },
      ],
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send booking confirmation email");
  }

  await notifyAdminsOfBooking(fastify, {
    studentName: student[0].displayName,
    productName: product?.name ?? "English",
    startsAt: startsAt!,
    meetLink,
  });

  return { bookingId: bookingId!, meetLink, startsAt: startsAt! };
}

/**
 * Every account with role "admin" gets notified — not just a single
 * hardcoded address, so this keeps working if more admins are added later.
 * Runs for both a fresh booking and the "new" half of a reschedule (same
 * call site), which is the right signal either way: the admin's calendar
 * changed, they should know.
 */
async function notifyAdminsOfBooking(
  fastify: FastifyInstance,
  booking: { studentName: string; productName: string; startsAt: Date; meetLink: string | null },
): Promise<void> {
  try {
    // A fixed inbox (env.campus.adminNotificationEmail) takes priority — it
    // doesn't need to be a login account at all, just where the alert should
    // land. Falls back to querying role="admin" accounts when unset, so this
    // keeps working even without that env var configured.
    let recipients: string[];
    if (env.campus.adminNotificationEmail) {
      recipients = [env.campus.adminNotificationEmail];
    } else {
      const admins = await fastify.drizzle
        .select({ email: accounts.email })
        .from(accounts)
        .where(and(eq(accounts.role, "admin"), eq(accounts.isActive, true)));
      recipients = admins.map((a) => a.email);
    }
    if (recipients.length === 0) return;

    const bogotaDate = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "full",
      timeStyle: "short",
    }).format(booking.startsAt);

    const safeStudent = escapeHtml(booking.studentName);
    const safeProduct = escapeHtml(booking.productName);

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: recipients.join(","),
      subject: `📅 Nueva clase agendada — ${safeStudent}`,
      html: renderEmailHtml({
        title: "Nueva clase agendada",
        bodyHtml: `
          <p>${safeStudent} agendó una clase de <strong>${safeProduct}</strong>.</p>
          <p><strong>Fecha:</strong> ${bogotaDate} (Colombia)</p>
          ${booking.meetLink ? `<p><strong>Link de videollamada:</strong> <a href="${booking.meetLink}" style="color:${BRAND_COLOR};">${booking.meetLink}</a></p>` : ""}
        `,
      }),
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send admin booking notification email");
  }
}

export async function listStudentBookings(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      meetLink: bookings.meetLink,
      cancelledAt: bookings.cancelledAt,
      studentNotes: bookings.studentNotes,
      productName: products.name,
      gcalEventId: bookings.gcalEventId,
    })
    .from(bookings)
    .innerJoin(products, eq(bookings.productId, products.id))
    .where(eq(bookings.studentId, userId))
    .orderBy(bookings.startsAt);
}

export async function cancelStudentBooking(
  fastify: FastifyInstance,
  bookingId: string,
  userId: string,
) {
  const [booking] = await fastify.drizzle
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.studentId, userId)))
    .limit(1);

  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new AppError(409, "BOOKING_NOT_CANCELLABLE", "Booking cannot be cancelled");
  }

  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (booking.startsAt <= cutoff) {
    throw new AppError(409, "CANCEL_CUTOFF", "Cannot cancel within 24 hours of class");
  }

  await fastify.drizzle.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "Student cancelled" })
      .where(eq(bookings.id, bookingId));

    if (booking.availabilityId) {
      await tx
        .update(availabilities)
        .set({ isBooked: false })
        .where(eq(availabilities.id, booking.availabilityId));
    }

    await tx
      .update(classCredits)
      .set({ usedCredits: sql`GREATEST(${classCredits.usedCredits} - 1, 0)` })
      .where(eq(classCredits.id, booking.creditId));
  });

  if (booking.gcalEventId) {
    try {
      await fastify.caldav.deleteEvent(booking.gcalEventId);
    } catch (err) {
      fastify.log.error({ err }, "Failed to delete CalDAV event");
    }
  }
}

interface RescheduleSource {
  id: string;
  studentId: string;
  creditId: string;
  availabilityId: string | null;
  gcalEventId: string | null;
  status: "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
  startsAt: Date;
}

// Moves a booking to a new slot reusing the SAME already-consumed credit —
// no refund on the old booking, no new charge on the new one. Creates the
// new booking FIRST: if the new slot is unavailable/invalid, the old
// booking is left completely untouched (safe default). Only once the new
// booking exists do we close out the old one.
async function rescheduleBookingInternal(fastify: FastifyInstance, booking: RescheduleSource, newSlotId: string) {
  const result = await createStudentBooking(fastify, {
    studentId: booking.studentId,
    slotId: newSlotId,
    creditId: booking.creditId,
    consumeCredit: false,
    replacesBookingId: booking.id,
  });

  // Conditional on the status we actually read earlier — if two reschedules
  // of the same booking race, only the first cancel here succeeds (0 rows
  // affected for the loser). Without this, both could create a new booking
  // off the same already-consumed credit before either cancels the source,
  // leaving two active bookings paid for by one credit.
  const cancelled = await fastify.drizzle
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "Rescheduled" })
    .where(and(eq(bookings.id, booking.id), eq(bookings.status, booking.status)))
    .returning({ id: bookings.id });

  if (cancelled.length === 0) {
    // Lost the race — undo the new booking we just created so it doesn't
    // sit alongside whatever concurrent change won, both drawing on one credit.
    await fastify.drizzle
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "Reschedule race — source booking already changed" })
      .where(eq(bookings.id, result.bookingId));
    throw new AppError(409, "BOOKING_MODIFIED", "Booking was already modified — reschedule aborted");
  }

  if (booking.availabilityId) {
    await fastify.drizzle
      .update(availabilities)
      .set({ isBooked: false })
      .where(eq(availabilities.id, booking.availabilityId));
  }

  if (booking.gcalEventId) {
    try {
      await fastify.caldav.deleteEvent(booking.gcalEventId);
    } catch (err) {
      fastify.log.error({ err }, "Failed to delete CalDAV event for rescheduled booking");
    }
  }

  return result;
}

// Student-initiated: same 24h cutoff as cancelStudentBooking.
export async function rescheduleStudentBooking(
  fastify: FastifyInstance,
  params: { bookingId: string; studentId: string; newSlotId: string },
) {
  const { bookingId, studentId, newSlotId } = params;

  const [booking] = await fastify.drizzle
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.studentId, studentId)))
    .limit(1);

  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new AppError(409, "BOOKING_NOT_RESCHEDULABLE", "Booking cannot be rescheduled");
  }

  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (booking.startsAt <= cutoff) {
    throw new AppError(409, "RESCHEDULE_CUTOFF", "Cannot reschedule within 24 hours of class");
  }

  return rescheduleBookingInternal(fastify, booking, newSlotId);
}

// Admin-initiated: no cutoff — admin can move any booking at any time.
export async function adminRescheduleBooking(
  fastify: FastifyInstance,
  params: { bookingId: string; newSlotId: string },
) {
  const { bookingId, newSlotId } = params;

  const [booking] = await fastify.drizzle
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new AppError(409, "BOOKING_NOT_RESCHEDULABLE", "Booking cannot be rescheduled");
  }

  return rescheduleBookingInternal(fastify, booking, newSlotId);
}
