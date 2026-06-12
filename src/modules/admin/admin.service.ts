import { eq, and, desc, asc, sql, ne } from "drizzle-orm";
import * as argon2 from "argon2";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import {
  accounts,
  bookings,
  availabilities,
  weeklySlots,
  classCredits,
  products,
  refreshTokens,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import "../../plugins/caldav.js";
import { createStudentBooking, getAvailableSlots } from "../schedule/schedule.service.js";

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
      .select({ email: accounts.email, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.id, booking.studentId!))
      .limit(1);

    if (student) {
      const bogotaDate = new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota",
        dateStyle: "full",
        timeStyle: "short",
      }).format(booking.startsAt!);

      await fastify.mailer.sendMail({
        from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
        to: student.email,
        subject: "❌ Clase cancelada",
        html: `
          <p>Hola ${student.displayName},</p>
          <p>Tu clase del <strong>${bogotaDate} (Colombia)</strong> ha sido cancelada.</p>
          ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ""}
          <p>Tu crédito ha sido reintegrado. Puedes agendar una nueva clase cuando gustes.</p>
          <p>— ${env.smtp.fromName}</p>
        `,
      });
    }
  } catch (err) {
    fastify.log.error({ err }, "Failed to send cancellation email");
  }
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
  }: {
    productId: string;
    totalCredits: number;
    paymentMethod: string;
    grantedBy: string;
    expiresAt?: string;
    notes?: string;
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
    columns: { id: true },
  });
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");

  const [credit] = await db
    .insert(classCredits)
    .values({
      userId,
      productId,
      orderId: null,
      grantedBy,
      paymentMethod,
      grantNotes: notes ?? null,
      totalCredits,
      usedCredits: 0,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })
    .returning({
      id: classCredits.id,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      paymentMethod: classCredits.paymentMethod,
      grantNotes: classCredits.grantNotes,
      createdAt: classCredits.createdAt,
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
  const now = new Date();
  const rows = await fastify.drizzle
    .select({
      creditId: classCredits.id,
      productName: products.name,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      expiresAt: classCredits.expiresAt,
    })
    .from(classCredits)
    .innerJoin(products, eq(classCredits.productId, products.id))
    .where(
      and(
        eq(classCredits.userId, userId),
        sql`${classCredits.usedCredits} < ${classCredits.totalCredits}`,
        sql`(${classCredits.expiresAt} IS NULL OR ${classCredits.expiresAt} > ${now})`,
      ),
    )
    .orderBy(asc(classCredits.expiresAt));

  return rows.map((r) => ({
    creditId: r.creditId,
    productName: r.productName,
    remaining: r.totalCredits - r.usedCredits,
    expiresAt: r.expiresAt,
  }));
}

export async function adminBookForStudent(
  fastify: FastifyInstance,
  studentId: string,
  { slotId, creditId }: { slotId: string; creditId: string },
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

export { getAvailableSlots };
