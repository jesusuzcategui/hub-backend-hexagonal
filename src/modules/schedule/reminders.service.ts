import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { accounts } from "../../db/schema/users.js";
import { bookings } from "../../db/schema/scheduling.js";
import { normalizeLocale, type Locale } from "../../lib/locale.js";
import {
  buildReminderEmail,
  dueReminders,
  maskEmail,
  reminderState,
  type ReminderCandidate,
  type ReminderKind,
  type ReminderState,
} from "./reminders.js";

const HOUR_MS = 3_600_000;
const DEFAULT_CAMPUS_URL = "https://campus.jesusuzcategui.com";

export interface ReminderSummary {
  dryRun: boolean;
  checked: number;
  sent24h: number;
  sent1h: number;
  skipped: number;
  failed: number;
  /** Only populated for dryRun: what a real pass would send right now. */
  wouldSend?: Array<{ bookingId: string; kind: ReminderKind; locale: Locale }>;
}

const claimColumn = {
  "24h": bookings.reminder24hSentAt,
  "1h": bookings.reminder1hSentAt,
} as const;

const claimKey = { "24h": "reminder24hSentAt", "1h": "reminder1hSentAt" } as const;

/**
 * One reminder pass. Safe to call from several instances/ticks at once:
 *
 *  1. Candidates = confirmed bookings of active students starting within the next 24h that still
 *     have at least one unsent flag (served by idx_bookings_reminder_scan).
 *  2. dueReminders() decides what is due (pure, see reminders.ts for the window/grace rules).
 *  3. Every due reminder is CLAIMED with `UPDATE ... SET flag = now WHERE id = $1 AND flag IS NULL
 *     RETURNING id` BEFORE sending. Only the caller whose UPDATE returns a row may send, so two
 *     concurrent passes can never double-send.
 *  4. If sending throws, the claim is cleared (only if it is still ours) so the next tick retries.
 *     The retry is bounded by the allowed window itself: once dueReminders() stops returning the
 *     booking (grace over / class started) it is never attempted again.
 *
 * dryRun computes step 1-2 only: nothing is claimed or sent.
 */
export async function runReminderPass(
  fastify: FastifyInstance,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<ReminderSummary> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const db = fastify.drizzle;

  const rows = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      createdAt: bookings.createdAt,
      reminder24hSentAt: bookings.reminder24hSentAt,
      reminder1hSentAt: bookings.reminder1hSentAt,
      meetLink: bookings.meetLink,
      email: accounts.email,
      displayName: accounts.displayName,
      locale: accounts.locale,
    })
    .from(bookings)
    .innerJoin(accounts, eq(accounts.id, bookings.studentId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        gt(bookings.startsAt, now),
        lte(bookings.startsAt, new Date(now.getTime() + 24 * HOUR_MS)),
        or(isNull(bookings.reminder24hSentAt), isNull(bookings.reminder1hSentAt)),
        eq(accounts.isActive, true),
        eq(accounts.status, "active"),
      ),
    )
    .orderBy(asc(bookings.startsAt));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const due = dueReminders(rows as ReminderCandidate[], now);

  const summary: ReminderSummary = {
    dryRun,
    checked: rows.length,
    sent24h: 0,
    sent1h: 0,
    skipped: rows.length - due.length,
    failed: 0,
  };

  if (dryRun) {
    summary.wouldSend = due.map((d) => ({
      bookingId: d.bookingId,
      kind: d.kind,
      locale: normalizeLocale(byId.get(d.bookingId)!.locale),
    }));
    return summary;
  }

  const siteUrl = env.campus.origin ?? DEFAULT_CAMPUS_URL;

  for (const { bookingId, kind } of due) {
    const row = byId.get(bookingId)!;
    const column = claimColumn[kind];

    const claimed = await db
      .update(bookings)
      .set({ [claimKey[kind]]: now })
      .where(and(eq(bookings.id, bookingId), isNull(column), eq(bookings.status, "confirmed")))
      .returning({ id: bookings.id });
    if (claimed.length === 0) {
      summary.skipped += 1; // another pass claimed it first, or it was cancelled meanwhile
      continue;
    }

    try {
      const mail = buildReminderEmail({
        kind,
        locale: normalizeLocale(row.locale),
        studentName: row.displayName,
        startsAt: row.startsAt,
        meetLink: row.meetLink,
        siteUrl,
      });
      await fastify.mailer.sendMail({
        from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
        to: row.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      if (kind === "24h") summary.sent24h += 1;
      else summary.sent1h += 1;
    } catch (err) {
      summary.failed += 1;
      // Booking id only: no email, name or error payload that could carry PII.
      fastify.log.warn({ bookingId, kind, errName: (err as Error)?.name }, "class reminder send failed, claim cleared");
      try {
        await db
          .update(bookings)
          .set({ [claimKey[kind]]: null })
          .where(and(eq(bookings.id, bookingId), eq(column, now)));
      } catch (clearErr) {
        fastify.log.error({ bookingId, kind, errName: (clearErr as Error)?.name }, "class reminder: failed to clear claim");
      }
    }
  }

  return summary;
}

export interface UpcomingReminder {
  bookingId: string;
  startsAt: Date;
  studentEmail: string;
  studentName: string;
  locale: Locale;
  reminder24h: { state: ReminderState; sentAt: Date | null };
  reminder1h: { state: ReminderState; sentAt: Date | null };
}

/** Confirmed bookings starting in the next `hours` hours with the state of each reminder (emails masked). */
export async function listUpcomingReminders(
  fastify: FastifyInstance,
  options: { now?: Date; hours?: number } = {},
): Promise<UpcomingReminder[]> {
  const now = options.now ?? new Date();
  const hours = options.hours ?? 48;

  const rows = await fastify.drizzle
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      createdAt: bookings.createdAt,
      reminder24hSentAt: bookings.reminder24hSentAt,
      reminder1hSentAt: bookings.reminder1hSentAt,
      email: accounts.email,
      displayName: accounts.displayName,
      locale: accounts.locale,
    })
    .from(bookings)
    .innerJoin(accounts, eq(accounts.id, bookings.studentId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        gt(bookings.startsAt, now),
        lte(bookings.startsAt, new Date(now.getTime() + hours * HOUR_MS)),
      ),
    )
    .orderBy(asc(bookings.startsAt));

  return rows.map((r) => ({
    bookingId: r.id,
    startsAt: r.startsAt,
    studentEmail: maskEmail(r.email),
    studentName: r.displayName,
    locale: normalizeLocale(r.locale),
    reminder24h: { state: reminderState(r, "24h", now), sentAt: r.reminder24hSentAt },
    reminder1h: { state: reminderState(r, "1h", now), sentAt: r.reminder1hSentAt },
  }));
}
