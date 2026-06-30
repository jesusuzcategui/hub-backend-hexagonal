import { boolean, index, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./users";
import { orders, products } from "./ecommerce";

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
  (table) => [index("idx_class_credits_user_id").on(table.userId)],
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
    status: bookingStatusEnum("status").notNull().default("pending"),
    gcalEventId: text("gcal_event_id"),
    meetLink: text("meet_link"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    studentNotes: text("student_notes"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
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
