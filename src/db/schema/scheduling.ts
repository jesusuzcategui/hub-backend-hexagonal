import {
  boolean,
  date,
  index,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./users";
import { products } from "./ecommerce";
import { orders } from "./payments";

export const schedulingSchema = pgSchema("scheduling");

export const bookingStatusEnum = schedulingSchema.enum("booking_status", [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
]);

export const weeklySlots = schedulingSchema.table(
  "weekly_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_weekly_slots_teacher_id").on(table.teacherId),
    index("idx_weekly_slots_day_of_week").on(table.dayOfWeek),
  ],
);

export const availabilities = schedulingSchema.table(
  "availabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    isBooked: boolean("is_booked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_availabilities_starts_at")
      .on(table.startsAt)
      .where(sql`${table.isBooked} = FALSE`),
  ],
);

export const classCredits = schedulingSchema.table(
  "class_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .references(() => orders.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    grantedBy: uuid("granted_by")
      .references(() => accounts.id, { onDelete: "set null" }),
    paymentMethod: text("payment_method"),
    grantNotes: text("grant_notes"),
    totalCredits: smallint("total_credits").notNull(),
    usedCredits: smallint("used_credits").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_class_credits_user_id").on(table.userId),
    uniqueIndex("uq_class_credits_order_id").on(table.orderId).where(sql`${table.orderId} IS NOT NULL`),
  ],
);

// A recurring-class series. Occurrences are ordinary bookings (series_id set); all credits are
// deducted at creation. `pattern` is [{ weekday: 0-6 (0 = Sunday), time: "HH:MM" }].
export const bookingSeries = schedulingSchema.table(
  "booking_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => accounts.id),
    pattern: jsonb("pattern").notNull(),
    intervalWeeks: smallint("interval_weeks").notNull(),
    startDate: date("start_date").notNull(),
    requestedOccurrences: smallint("requested_occurrences").notNull(),
    createdOccurrences: smallint("created_occurrences").notNull(),
    status: text("status").notNull().default("active"), // active | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Idempotent creation (POST /schedule/series with an Idempotency-Key header). All three are
    // NULL for series created without a key. Kept for as long as the series row exists.
    idempotencyKey: text("idempotency_key"),
    requestFingerprint: text("request_fingerprint"),
    idempotencyResponse: jsonb("idempotency_response"),
  },
  (table) => [
    index("idx_booking_series_student_id").on(table.studentId),
    uniqueIndex("uq_booking_series_student_idempotency_key")
      .on(table.studentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const bookings = schedulingSchema.table(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    creditId: uuid("credit_id")
      .notNull()
      .references(() => classCredits.id, { onDelete: "restrict" }),
    availabilityId: uuid("availability_id")
      .references(() => availabilities.id, { onDelete: "restrict" }),
    weeklySlotId: uuid("weekly_slot_id")
      .references(() => weeklySlots.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    seriesId: uuid("series_id").references(() => bookingSeries.id, { onDelete: "set null" }),
    status: bookingStatusEnum("status").notNull().default("pending"),
    gcalEventId: text("gcal_event_id"),
    meetLink: text("meet_link"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    studentNotes: text("student_notes"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }), // legacy, unused
    reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
    reminder1hSentAt: timestamp("reminder_1h_sent_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_bookings_student_id").on(table.studentId),
    index("idx_bookings_weekly_slot_id").on(table.weeklySlotId),
    index("idx_bookings_starts_at").on(table.startsAt),
    index("idx_bookings_status").on(table.status),
    index("idx_bookings_series_id").on(table.seriesId),
    index("idx_bookings_reminder_scan")
      .on(table.startsAt)
      .where(sql`${table.status} = 'confirmed'`),
  ],
);

// One note per booking (upsert on write), attachments stored on WebDAV — this table
// only keeps pointers, same pattern as manual-transfer proofs in payments.service.ts.
export const classNotes = schedulingSchema.table(
  "class_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => accounts.id, { onDelete: "set null" }),
    content: text("content").notNull().default(""),
    attachments: jsonb("attachments").notNull().default([]), // Array<{ filename: string; path: string; contentType: string }>
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("uq_class_notes_booking_id").on(table.bookingId)],
);

// A time range the teacher is unavailable (vacation, one-off block, etc).
// Independent of weeklySlots.isActive: deactivating a weekly slot removes it
// from the recurring pattern entirely, while a blocked_slot just closes a
// specific window without touching the pattern — the slot reopens on its own
// once the block's range is in the past.
export const blockedSlots = schedulingSchema.table(
  "blocked_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    // 'manual' = created through the admin API; 'caldav' = mirrored from the owner's Nextcloud calendar by the sync
    // (reason is the constant 'nextcloud'). The sync only ever touches 'caldav' rows.
    source: text("source").notNull().default("manual"),
    // Stable id of one calendar event instance: "<UID>|<recurrence instance start>". Only set for caldav rows.
    externalKey: text("external_key"),
    // Event title from the calendar. ADMIN-ONLY: never return it on a student or public endpoint, never log it.
    externalSummary: text("external_summary"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_blocked_slots_teacher_id").on(table.teacherId),
    index("idx_blocked_slots_starts_at").on(table.startsAt),
    uniqueIndex("uq_blocked_slots_caldav_key")
      .on(table.source, table.externalKey)
      .where(sql`${table.source} = 'caldav'`),
  ],
);

export const mentoringRequests = schedulingSchema.table(
  "mentoring_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    whatsapp: text("whatsapp"),
    type: text("type").notNull(), // wordpress | shopify | custom | quote
    message: text("message"),
    slotId: text("slot_id").notNull(), // composite: weeklySlotId_YYYYMMDD_HHMM
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    gcalEventId: text("gcal_event_id"),
    status: text("status").notNull().default("pending"), // pending | confirmed | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_mentoring_requests_slot_id").on(table.slotId),
    index("idx_mentoring_requests_starts_at").on(table.startsAt),
    index("idx_mentoring_requests_status").on(table.status),
  ],
);
