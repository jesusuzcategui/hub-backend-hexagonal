import { eq, and, desc, asc, sql, ne } from "drizzle-orm";
import * as argon2 from "argon2";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import {
  accounts,
  bookings,
  availabilities,
  weeklySlots,
  blockedSlots,
  classCredits,
  products,
  refreshTokens,
  coupons,
  paymentMethodSettings,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import "../../plugins/caldav.js";
import { adminRescheduleBooking, createStudentBooking, getAvailableSlots, getStudentCredits } from "../schedule/schedule.service.js";
import { buildBookingCancelledEmail, buildWeeklySlotChangeEmail } from "../schedule/student-emails.js";
import { resolveGrantExpiry } from "../schedule/credit-balance.js";
import { reverifyOrder } from "../payments/review-verification.service.js";
import { escapeHtml, getManualTransferProof, getOrderDetailForAdmin, listOrdersForAdmin, validateManualTransfer, resolveOrderReview, listPaymentMethods, type PaymentMethod } from "../payments/payments.service.js";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template.js";
import { createCart } from "../cart/cart.service.js";
import { toDecimalMajor } from "../../adapters/payments/money.js";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function createStudent(
  fastify: FastifyInstance,
  {
    email,
    displayName,
    password,
    role,
  }: { email: string; displayName: string; password: string; role: "user" | "teacher" | "admin" },
) {
  const db = fastify.drizzle;

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.email, email.toLowerCase().trim()),
    columns: { id: true },
  });
  if (existing) throw new AppError(409, "EMAIL_TAKEN", "Email already registered");

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  const [account] = await db
    .insert(accounts)
    .values({
      email: email.toLowerCase().trim(),
      displayName: displayName.trim(),
      passwordHash,
      role,
      isActive: true,
    })
    .returning({
      id: accounts.id,
      email: accounts.email,
      displayName: accounts.displayName,
      role: accounts.role,
      createdAt: accounts.createdAt,
    });

  return account;
}

type BookingStatus = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
const VALID_STATUSES: BookingStatus[] = ["pending", "confirmed", "cancelled", "completed", "no_show"];

export async function listStudents(fastify: FastifyInstance) {
  return fastify.drizzle
    .select({
      id: accounts.id,
      email: accounts.email,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      status: accounts.status,
      createdAt: accounts.createdAt,
      availableCredits: sql<number>`COALESCE(SUM(${classCredits.totalCredits} - ${classCredits.usedCredits}), 0)`,
    })
    .from(accounts)
    .leftJoin(classCredits, eq(classCredits.userId, accounts.id))
    .where(and(eq(accounts.role, "user"), ne(accounts.status, "deleted")))
    .groupBy(accounts.id, accounts.email, accounts.displayName, accounts.avatarUrl, accounts.status, accounts.createdAt)
    .orderBy(asc(accounts.createdAt));
}

export async function getStudent(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, userId), eq(accounts.isActive, true)),
    columns: { id: true, email: true, displayName: true, avatarUrl: true, role: true, createdAt: true },
  });

  if (!account || account.role === "admin") {
    throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  }

  const [creditRow] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${classCredits.totalCredits}), 0)`,
      used: sql<number>`COALESCE(SUM(${classCredits.usedCredits}), 0)`,
    })
    .from(classCredits)
    .where(eq(classCredits.userId, userId));

  const studentBookings = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      meetLink: bookings.meetLink,
      cancelReason: bookings.cancelReason,
      productName: products.name,
    })
    .from(bookings)
    .leftJoin(products, eq(products.id, bookings.productId))
    .where(eq(bookings.studentId, userId))
    .orderBy(desc(bookings.startsAt))
    .limit(10);

  return {
    ...account,
    availableCredits: Number(creditRow?.total ?? 0) - Number(creditRow?.used ?? 0),
    bookings: studentBookings,
  };
}

// Admin-only "log in as this student" for testing — short-lived access
// token only (same expiry as a normal login), no refresh cookie. Minting a
// refresh cookie here would overwrite the admin's own session cookie in
// their browser, logging them out of their own account; the access token
// alone is enough to drive the student UI for a quick test, and expiring
// normally (no silent refresh) is the right failure mode for this.
export async function impersonateStudent(fastify: FastifyInstance, userId: string): Promise<string> {
  const account = await fastify.drizzle.query.accounts.findFirst({
    where: and(eq(accounts.id, userId), eq(accounts.isActive, true)),
    columns: { id: true, role: true },
  });
  if (!account || account.role === "admin") {
    throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  }
  return fastify.signAccessToken({ sub: account.id, role: account.role });
}

const VALID_PAYMENT_METHODS: PaymentMethod[] = ["epayco", "paypal", "manual_transfer"];

export async function listPaymentMethodsForAdmin(fastify: FastifyInstance) {
  return listPaymentMethods(fastify);
}

export async function setPaymentMethodEnabled(
  fastify: FastifyInstance,
  method: string,
  enabled: boolean,
): Promise<void> {
  if (!(VALID_PAYMENT_METHODS as string[]).includes(method)) {
    throw new AppError(400, "INVALID_METHOD", "Unknown payment method");
  }
  await fastify.drizzle
    .insert(paymentMethodSettings)
    .values({ method, enabled })
    .onConflictDoUpdate({ target: paymentMethodSettings.method, set: { enabled, updatedAt: new Date() } });
}

export async function listBookings(fastify: FastifyInstance, status?: string) {
  const db = fastify.drizzle;

  const baseQuery = db
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      meetLink: bookings.meetLink,
      studentNotes: bookings.studentNotes,
      cancelledAt: bookings.cancelledAt,
      cancelReason: bookings.cancelReason,
      createdAt: bookings.createdAt,
      studentId: accounts.id,
      studentName: accounts.displayName,
      studentEmail: accounts.email,
      productName: products.name,
    })
    .from(bookings)
    .leftJoin(accounts, eq(accounts.id, bookings.studentId))
    .leftJoin(products, eq(products.id, bookings.productId))
    .orderBy(desc(bookings.startsAt));

  if (status && (VALID_STATUSES as string[]).includes(status)) {
    return baseQuery.where(eq(bookings.status, status as BookingStatus));
  }

  return baseQuery;
}

// Classes actually given — distinct from listBookings (which shows every
// status for the calendar view): this is "completed" only, with
// student/package filters, for the Reportes page.
export async function listClassesGiven(
  fastify: FastifyInstance,
  filters: { studentId?: string; productId?: string },
) {
  const db = fastify.drizzle;

  const conditions = [eq(bookings.status, "completed")];
  if (filters.studentId) conditions.push(eq(bookings.studentId, filters.studentId));
  if (filters.productId) conditions.push(eq(bookings.productId, filters.productId));

  return db
    .select({
      id: bookings.id,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      studentId: accounts.id,
      studentName: accounts.displayName,
      studentEmail: accounts.email,
      productId: products.id,
      productName: products.name,
    })
    .from(bookings)
    .leftJoin(accounts, eq(accounts.id, bookings.studentId))
    .leftJoin(products, eq(products.id, bookings.productId))
    .where(and(...conditions))
    .orderBy(desc(bookings.startsAt));
}

export async function cancelBooking(
  fastify: FastifyInstance,
  bookingId: string,
  reason?: string,
) {
  const db = fastify.drizzle;

  const booking = await db.query.bookings.findFirst({
    where: eq(bookings.id, bookingId),
    columns: { id: true, status: true, availabilityId: true, creditId: true, gcalEventId: true, studentId: true, startsAt: true },
  });

  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if (booking.status === "cancelled") {
    throw new AppError(400, "ALREADY_CANCELLED", "Booking is already cancelled");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
        updatedAt: new Date(),
      })
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

  // Send cancellation email to student
  try {
    const [student] = await fastify.drizzle
      .select({ email: accounts.email, displayName: accounts.displayName, locale: accounts.locale })
      .from(accounts)
      .where(eq(accounts.id, booking.studentId!))
      .limit(1);

    if (student) {
      const cancelled = buildBookingCancelledEmail({
        locale: student.locale,
        studentName: student.displayName,
        startsAt: booking.startsAt!,
        reason,
      });

      await fastify.mailer.sendMail({
        from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
        to: student.email,
        subject: cancelled.subject,
        html: cancelled.html,
      });
    }
  } catch (err) {
    fastify.log.error({ err }, "Failed to send cancellation email");
  }
}

// Attendance is marked after the class happens. The credit was already consumed at
// booking time (see schedule.service.ts), so marking `attended: false` does NOT refund
// it — a no-show still spends the credit, same policy as most mentoring/coaching platforms.
export async function markAttendance(
  fastify: FastifyInstance,
  bookingId: string,
  attended: boolean,
) {
  const db = fastify.drizzle;

  const booking = await db.query.bookings.findFirst({
    where: eq(bookings.id, bookingId),
    columns: { id: true, status: true },
  });

  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if (booking.status === "cancelled") {
    throw new AppError(400, "BOOKING_CANCELLED", "Cannot mark attendance on a cancelled booking");
  }

  const [updated] = await db
    .update(bookings)
    .set({ status: attended ? "completed" : "no_show", updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))
    .returning({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
    });

  return updated;
}

export async function listAvailabilities(fastify: FastifyInstance) {
  return fastify.drizzle.query.availabilities.findMany({
    columns: { id: true, startsAt: true, endsAt: true, isBooked: true, createdAt: true },
    orderBy: [asc(availabilities.startsAt)],
  });
}

export async function createAvailability(
  fastify: FastifyInstance,
  teacherId: string,
  startsAt: string,
  endsAt: string,
) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new AppError(400, "INVALID_DATE", "Invalid date format");
  }
  if (end <= start) {
    throw new AppError(400, "INVALID_RANGE", "endsAt must be after startsAt");
  }

  const [slot] = await fastify.drizzle
    .insert(availabilities)
    .values({ teacherId, startsAt: start, endsAt: end })
    .returning({
      id: availabilities.id,
      startsAt: availabilities.startsAt,
      endsAt: availabilities.endsAt,
      isBooked: availabilities.isBooked,
    });

  return slot;
}

export async function deleteAvailability(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;

  const slot = await db.query.availabilities.findFirst({
    where: eq(availabilities.id, id),
    columns: { id: true, isBooked: true },
  });

  if (!slot) throw new AppError(404, "SLOT_NOT_FOUND", "Availability slot not found");
  if (slot.isBooked) throw new AppError(400, "SLOT_BOOKED", "Cannot delete a booked slot");

  await db.delete(availabilities).where(eq(availabilities.id, id));
}

export async function listWeeklySlots(fastify: FastifyInstance) {
  return fastify.drizzle
    .select({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
      isActive: weeklySlots.isActive,
      createdAt: weeklySlots.createdAt,
    })
    .from(weeklySlots)
    .orderBy(asc(weeklySlots.dayOfWeek), asc(weeklySlots.startTime));
}

export async function createWeeklySlot(
  fastify: FastifyInstance,
  teacherId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
) {
  if (dayOfWeek < 0 || dayOfWeek > 6) {
    throw new AppError(400, "INVALID_DAY", "dayOfWeek must be 0–6 (Sun=0)");
  }
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    throw new AppError(400, "INVALID_TIME", "Times must be HH:MM format");
  }
  if (endTime <= startTime) {
    throw new AppError(400, "INVALID_RANGE", "endTime must be after startTime");
  }

  const [slot] = await fastify.drizzle
    .insert(weeklySlots)
    .values({ teacherId, dayOfWeek, startTime, endTime, isActive: true })
    .returning({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
      isActive: weeklySlots.isActive,
    });

  return slot;
}

export async function deleteWeeklySlot(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;

  const slot = await db.query.weeklySlots.findFirst({
    where: eq(weeklySlots.id, id),
    columns: { id: true },
  });

  if (!slot) throw new AppError(404, "SLOT_NOT_FOUND", "Weekly slot not found");

  const [activeBooking] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.weeklySlotId, id),
        sql`${bookings.status} NOT IN ('cancelled', 'completed')`,
        sql`${bookings.startsAt} > NOW()`,
      ),
    )
    .limit(1);

  if (activeBooking) {
    throw new AppError(400, "SLOT_HAS_BOOKINGS", "Cannot delete slot with upcoming active bookings");
  }

  await db.delete(weeklySlots).where(eq(weeklySlots.id, id));
}

export async function deactivateWeeklySlot(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;

  const slot = await db.query.weeklySlots.findFirst({
    where: eq(weeklySlots.id, id),
    columns: { id: true },
  });

  if (!slot) throw new AppError(404, "SLOT_NOT_FOUND", "Weekly slot not found");

  const [updated] = await db
    .update(weeklySlots)
    .set({ isActive: false })
    .where(eq(weeklySlots.id, id))
    .returning({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
      isActive: weeklySlots.isActive,
      createdAt: weeklySlots.createdAt,
    });

  const affectedBookings = await db
    .select({
      id: bookings.id,
      startsAt: bookings.startsAt,
      studentEmail: accounts.email,
      studentName: accounts.displayName,
      studentLocale: accounts.locale,
    })
    .from(bookings)
    .innerJoin(accounts, eq(accounts.id, bookings.studentId))
    .where(
      and(
        eq(bookings.weeklySlotId, id),
        sql`${bookings.status} NOT IN ('cancelled', 'completed')`,
        sql`${bookings.startsAt} > NOW()`,
      ),
    );

  let notifiedBookings = 0;

  for (const booking of affectedBookings) {
    try {
      const change = buildWeeklySlotChangeEmail({
        locale: booking.studentLocale,
        studentName: booking.studentName,
        startsAt: booking.startsAt,
      });

      await fastify.mailer.sendMail({
        from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
        to: booking.studentEmail,
        subject: change.subject,
        html: change.html,
      });
      notifiedBookings += 1;
    } catch (err) {
      fastify.log.error({ err }, "Failed to send weekly slot deactivation email");
    }
  }

  return { slot: updated, notifiedBookings };
}

export async function reactivateWeeklySlot(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;

  const slot = await db.query.weeklySlots.findFirst({
    where: eq(weeklySlots.id, id),
    columns: { id: true },
  });

  if (!slot) throw new AppError(404, "SLOT_NOT_FOUND", "Weekly slot not found");

  const [updated] = await db
    .update(weeklySlots)
    .set({ isActive: true })
    .where(eq(weeklySlots.id, id))
    .returning({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
      isActive: weeklySlots.isActive,
      createdAt: weeklySlots.createdAt,
    });

  return updated;
}

export async function listStudentCredits(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle
    .select({
      id: classCredits.id,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      expiresAt: classCredits.expiresAt,
      paymentMethod: classCredits.paymentMethod,
      grantNotes: classCredits.grantNotes,
      createdAt: classCredits.createdAt,
      productName: products.name,
    })
    .from(classCredits)
    .leftJoin(products, eq(products.id, classCredits.productId))
    .where(eq(classCredits.userId, userId))
    .orderBy(desc(classCredits.createdAt));
}

export async function grantCreditsToStudent(
  fastify: FastifyInstance,
  userId: string,
  {
    productId,
    totalCredits,
    paymentMethod,
    grantedBy,
    expiresAt,
    notes,
    orderId,
  }: {
    productId: string;
    totalCredits: number;
    paymentMethod: string;
    grantedBy: string;
    expiresAt?: string;
    notes?: string;
    /** Links the credit block back to the payments order that funded it (settlement callers). Manual admin grants (no order behind them) omit this and get NULL, same as before. */
    orderId?: string | null;
  },
) {
  const db = fastify.drizzle;

  const student = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, userId), eq(accounts.isActive, true)),
    columns: { id: true, role: true },
  });
  if (!student || student.role === "admin") {
    throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  }

  const product = await db.query.products.findFirst({
    where: and(eq(products.id, productId), eq(products.isActive, true)),
    columns: { id: true, metadata: true },
  });
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");

  // Validity is counted from the grant date: explicit admin date wins, else the
  // product's metadata.validityDays, else 60 days.
  let explicitExpiry: Date | null = null;
  if (expiresAt) {
    explicitExpiry = new Date(expiresAt);
    if (Number.isNaN(explicitExpiry.getTime())) {
      throw new AppError(400, "INVALID_EXPIRES_AT", "expiresAt must be a valid date");
    }
  }

  const [credit] = await db
    .insert(classCredits)
    .values({
      userId,
      productId,
      orderId: orderId ?? null,
      grantedBy,
      paymentMethod,
      grantNotes: notes ?? null,
      totalCredits,
      usedCredits: 0,
      expiresAt: resolveGrantExpiry(new Date(), product.metadata, explicitExpiry),
    })
    .returning({
      id: classCredits.id,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      paymentMethod: classCredits.paymentMethod,
      grantNotes: classCredits.grantNotes,
      createdAt: classCredits.createdAt,
      expiresAt: classCredits.expiresAt,
    });

  return credit;
}

export async function updateStudent(
  fastify: FastifyInstance,
  userId: string,
  { displayName, email, role, password }: { displayName?: string; email?: string; role?: "user" | "teacher" | "admin"; password?: string },
) {
  const db = fastify.drizzle;

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: { id: true, role: true },
  });
  if (!existing) throw new AppError(404, "STUDENT_NOT_FOUND", "User not found");

  const updates: Record<string, unknown> = {};
  if (displayName) updates.displayName = displayName.trim();
  if (email) {
    const taken = await db.query.accounts.findFirst({
      where: and(eq(accounts.email, email.toLowerCase().trim()), sql`${accounts.id} != ${userId}`),
      columns: { id: true },
    });
    if (taken) throw new AppError(409, "EMAIL_TAKEN", "Email already in use");
    updates.email = email.toLowerCase().trim();
  }
  if (role) updates.role = role;
  if (password) updates.passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(accounts)
    .set(updates)
    .where(eq(accounts.id, userId))
    .returning({ id: accounts.id, email: accounts.email, displayName: accounts.displayName, role: accounts.role });

  return updated;
}

export async function listStudentActiveCredits(fastify: FastifyInstance, userId: string) {
  return getStudentCredits(fastify, userId);
}

export async function adminBookForStudent(
  fastify: FastifyInstance,
  studentId: string,
  { slotId, creditId }: { slotId: string; creditId?: string },
) {
  const student = await fastify.drizzle.query.accounts.findFirst({
    where: and(eq(accounts.id, studentId), eq(accounts.isActive, true)),
    columns: { id: true, role: true },
  });
  if (!student || student.role === "admin") {
    throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  }

  return createStudentBooking(fastify, { studentId, slotId, creditId });
}

export async function blockStudent(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: { id: true, role: true, status: true },
  });
  if (!account || account.role === "admin") throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  if (account.status === "blocked") throw new AppError(400, "ALREADY_BLOCKED", "User is already blocked");

  const [updated] = await db
    .update(accounts)
    .set({ status: "blocked", isActive: false, updatedAt: new Date() })
    .where(eq(accounts.id, userId))
    .returning({ id: accounts.id, status: accounts.status });

  return updated;
}

export async function unblockStudent(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: { id: true, role: true, status: true },
  });
  if (!account || account.role === "admin") throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  if (account.status !== "blocked") throw new AppError(400, "NOT_BLOCKED", "User is not blocked");

  const [updated] = await db
    .update(accounts)
    .set({ status: "active", isActive: true, updatedAt: new Date() })
    .where(eq(accounts.id, userId))
    .returning({ id: accounts.id, status: accounts.status });

  return updated;
}

export async function deleteStudent(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: { id: true, role: true, status: true },
  });
  if (!account || account.role === "admin") throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found");
  if (account.status === "deleted") throw new AppError(400, "ALREADY_DELETED", "User is already deleted");

  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ status: "deleted", isActive: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, userId));

    // Revoke all refresh tokens
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  });
}

export async function listOrders(
  fastify: FastifyInstance,
  filters: { status?: string; fulfillmentStatus?: string },
) {
  return listOrdersForAdmin(fastify, filters);
}

export async function validateTransfer(
  fastify: FastifyInstance,
  orderId: string,
  decision: "approve" | "reject",
) {
  return validateManualTransfer(fastify, orderId, decision);
}

export async function reverifyReview(fastify: FastifyInstance, orderId: string) {
  return reverifyOrder(fastify, orderId);
}

export async function resolveReview(fastify: FastifyInstance, orderId: string) {
  return resolveOrderReview(fastify, orderId);
}

export async function getOrderDetail(fastify: FastifyInstance, orderId: string) {
  return getOrderDetailForAdmin(fastify, orderId);
}

export async function getOrderProof(fastify: FastifyInstance, orderId: string) {
  return getManualTransferProof(fastify, orderId);
}

// --- Coupons ------------------------------------------------------------------------

export async function listCoupons(fastify: FastifyInstance) {
  return fastify.drizzle.query.coupons.findMany({ orderBy: desc(coupons.createdAt) });
}

export async function createCoupon(
  fastify: FastifyInstance,
  input: {
    code: string;
    type: "percent" | "fixed";
    value: number;
    currency?: string | null;
    maxRedemptions?: number | null;
    expiresAt?: Date | null;
  },
) {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new AppError(400, "INVALID_CODE", "code is required");
  if (input.type === "percent" && (input.value < 0 || input.value > 100)) {
    throw new AppError(400, "INVALID_VALUE", "percent value must be between 0 and 100");
  }
  if (input.type === "fixed" && input.value < 0) {
    throw new AppError(400, "INVALID_VALUE", "fixed value must be >= 0");
  }

  const existing = await fastify.drizzle.query.coupons.findFirst({
    where: eq(coupons.code, code),
    columns: { id: true },
  });
  if (existing) throw new AppError(409, "COUPON_EXISTS", "A coupon with this code already exists");

  const [coupon] = await fastify.drizzle
    .insert(coupons)
    .values({
      code,
      type: input.type,
      value: input.value,
      currency: input.type === "fixed" ? (input.currency ?? null) : null,
      maxRedemptions: input.maxRedemptions ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  return coupon;
}

export async function deactivateCoupon(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;
  const coupon = await db.query.coupons.findFirst({ where: eq(coupons.id, id), columns: { id: true } });
  if (!coupon) throw new AppError(404, "COUPON_NOT_FOUND", "Coupon not found");

  const [updated] = await db
    .update(coupons)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(coupons.id, id))
    .returning();
  return updated;
}

export async function reactivateCoupon(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;
  const coupon = await db.query.coupons.findFirst({ where: eq(coupons.id, id), columns: { id: true } });
  if (!coupon) throw new AppError(404, "COUPON_NOT_FOUND", "Coupon not found");

  const [updated] = await db
    .update(coupons)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(coupons.id, id))
    .returning();
  return updated;
}

export { getAvailableSlots };

// --- Reschedule --------------------------------------------------------------------

export async function rescheduleBooking(fastify: FastifyInstance, bookingId: string, newSlotId: string) {
  try {
    return await adminRescheduleBooking(fastify, { bookingId, newSlotId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Reschedule failed";
    const status = msg.includes("not found") ? 404 : msg.includes("already booked") || msg.includes("blocked") ? 409 : 400;
    throw new AppError(status, "RESCHEDULE_FAILED", msg);
  }
}

// --- Blocked slots -------------------------------------------------------------------

export async function listBlockedSlots(fastify: FastifyInstance) {
  return fastify.drizzle.query.blockedSlots.findMany({ orderBy: asc(blockedSlots.startsAt) });
}

export async function createBlockedSlot(
  fastify: FastifyInstance,
  input: { teacherId: string; startsAt: string; endsAt: string; reason?: string },
) {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) {
    throw new AppError(400, "INVALID_DATE", "Invalid date format");
  }
  if (endsAt <= startsAt) throw new AppError(400, "INVALID_RANGE", "endsAt must be after startsAt");

  const [block] = await fastify.drizzle
    .insert(blockedSlots)
    .values({ teacherId: input.teacherId, startsAt, endsAt, reason: input.reason ?? null })
    .returning();
  return block;
}

export async function deleteBlockedSlot(fastify: FastifyInstance, id: string) {
  const db = fastify.drizzle;
  const block = await db.query.blockedSlots.findFirst({ where: eq(blockedSlots.id, id), columns: { id: true } });
  if (!block) throw new AppError(404, "BLOCK_NOT_FOUND", "Blocked slot not found");
  await db.delete(blockedSlots).where(eq(blockedSlots.id, id));
}

// --- Admin-generated checkout links ---------------------------------------------------
//
// Lets an admin create a cart on a buyer's behalf (no account required — same anonymous
// cart the storefront uses) and email them the checkout link, instead of the buyer having
// to start from the shop page themselves. Reuses cart.service.ts's createCart as-is; the
// buyer picks their own payment method (epayco/paypal/manual transfer) on that page,
// nothing here decides that for them.

export async function createCheckoutLink(
  fastify: FastifyInstance,
  input: {
    buyerEmail: string;
    buyerName?: string;
    currency: string;
    locale?: "en" | "es";
  } & (
    | { productId: string; qty?: number; customAmountMinor?: undefined; customLabel?: undefined }
    // No real product — an ad-hoc charge (outstanding balance, a one-off
    // fee) collected through the same checkout-link/cart flow. See
    // priceCartItems in payments.service.ts for how this is priced.
    | { productId?: undefined; qty?: undefined; customAmountMinor: number; customLabel: string }
  ),
) {
  const currency = input.currency.toUpperCase();
  const locale = input.locale ?? "es";

  let cartItem: { planId: string; qty: number; customAmountMinor?: number; customLabel?: string };
  let displayName: string;
  let priceMinor: number;

  if (input.customAmountMinor !== undefined) {
    cartItem = { planId: "custom", qty: 1, customAmountMinor: input.customAmountMinor, customLabel: input.customLabel };
    displayName = input.customLabel;
    priceMinor = input.customAmountMinor;
  } else {
    const product = await fastify.drizzle.query.products.findFirst({
      where: eq(products.id, input.productId),
      columns: { id: true, name: true, priceCop: true, priceUsd: true, isActive: true },
    });
    if (!product || !product.isActive) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found or inactive");
    }
    const qty = input.qty ?? 1;
    cartItem = { planId: input.productId, qty };
    displayName = product.name;
    priceMinor = (currency === "USD" ? product.priceUsd : product.priceCop) * qty;
  }

  const cart = await createCart(fastify, {
    items: [cartItem],
    buyerEmail: input.buyerEmail,
    buyerName: input.buyerName,
    currency,
    locale,
  });

  const base = (env.app.publicUrl ?? "").replace(/\/+$/, "");
  const checkoutUrl = locale === "en" ? `${base}/en/cart/${cart.token}` : `${base}/cart/${cart.token}`;

  const priceLabel = `${toDecimalMajor(priceMinor, currency)} ${currency}`;

  const safeName = escapeHtml(input.buyerName ?? input.buyerEmail);
  const safeProduct = escapeHtml(displayName);
  const safeUrl = escapeHtml(checkoutUrl);

  const subject = locale === "en" ? `Complete your purchase — ${displayName}` : `Completá tu compra — ${displayName}`;
  const buttonLabel = locale === "en" ? "Complete purchase" : "Completar compra";
  const bodyHtml = locale === "en"
    ? `
      <p>Hi ${safeName},</p>
      <p>You have a pending purchase: <strong>${safeProduct}</strong> (${priceLabel}).</p>
      <p>Click below to choose your payment method and complete it:</p>
      <p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${buttonLabel}</a></p>
      <p style="color:#8a939c; font-size:13px;">${safeUrl}</p>
    `
    : `
      <p>Hola ${safeName},</p>
      <p>Tenés una compra pendiente: <strong>${safeProduct}</strong> (${priceLabel}).</p>
      <p>Hacé clic abajo para elegir tu método de pago y completarla:</p>
      <p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${buttonLabel}</a></p>
      <p style="color:#8a939c; font-size:13px;">${safeUrl}</p>
    `;

  await fastify.mailer.sendMail({
    from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
    to: input.buyerEmail,
    subject,
    html: renderEmailHtml({ title: subject, bodyHtml, locale }),
  });

  return { cartToken: cart.token, checkoutUrl };
}
