import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "../../lib/errors";
import {
  listStudents,
  getStudent,
  createStudent,
  updateStudent,
  blockStudent,
  unblockStudent,
  deleteStudent,
  listBookings,
  cancelBooking,
  listAvailabilities,
  createAvailability,
  deleteAvailability,
  listWeeklySlots,
  createWeeklySlot,
  deleteWeeklySlot,
  listStudentCredits,
  grantCreditsToStudent,
  listStudentActiveCredits,
  adminBookForStudent,
  getAvailableSlots,
} from "./admin.service";

async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin access required");
  }
}

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Students
  fastify.get("/admin/students", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await listStudents(fastify) });
  });

  fastify.post("/admin/students", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string;
      displayName?: string;
      password?: string;
      role?: string;
    };
    if (!body.email || !body.displayName || !body.password) {
      throw new AppError(400, "MISSING_FIELDS", "email, displayName, and password are required");
    }
    if (body.role && !["user", "teacher"].includes(body.role)) {
      throw new AppError(400, "INVALID_ROLE", "role must be user or teacher");
    }
    const data = await createStudent(fastify, {
      email: body.email,
      displayName: body.displayName,
      password: body.password,
      role: (body.role as "user" | "teacher" | "admin") ?? "user",
    });
    reply.status(201).send({ data });
  });

  fastify.get("/admin/students/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send({ data: await getStudent(fastify, id) });
  });

  fastify.patch("/admin/students/:id/block", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await blockStudent(fastify, id);
    reply.send({ data });
  });

  fastify.patch("/admin/students/:id/unblock", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await unblockStudent(fastify, id);
    reply.send({ data });
  });

  fastify.delete("/admin/students/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteStudent(fastify, id);
    reply.send({ data: { deleted: true } });
  });

  fastify.patch("/admin/students/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { displayName?: string; email?: string; role?: string; password?: string };
    if (body.role && !["user", "teacher", "admin"].includes(body.role)) {
      throw new AppError(400, "INVALID_ROLE", "role must be user, teacher, or admin");
    }
    const data = await updateStudent(fastify, id, {
      displayName: body.displayName,
      email: body.email,
      role: body.role as "user" | "teacher" | "admin" | undefined,
      password: body.password,
    });
    reply.send({ data });
  });

  // Bookings
  fastify.get("/admin/bookings", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { status } = req.query as { status?: string };
    reply.send({ data: await listBookings(fastify, status) });
  });

  fastify.patch("/admin/bookings/:id/cancel", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    await cancelBooking(fastify, id, reason);
    reply.send({ data: { cancelled: true } });
  });

  // Availabilities
  fastify.get("/admin/availabilities", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await listAvailabilities(fastify) });
  });

  fastify.post("/admin/availabilities", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { startsAt, endsAt } = (req.body ?? {}) as { startsAt?: string; endsAt?: string };
    if (!startsAt || !endsAt) throw new AppError(400, "MISSING_FIELDS", "startsAt and endsAt are required");
    const data = await createAvailability(fastify, req.user.sub, startsAt, endsAt);
    reply.status(201).send({ data });
  });

  fastify.delete("/admin/availabilities/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteAvailability(fastify, id);
    reply.send({ data: { deleted: true } });
  });

  // Weekly slots
  fastify.get("/admin/weekly-slots", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await listWeeklySlots(fastify) });
  });

  fastify.post("/admin/weekly-slots", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as { dayOfWeek?: number; startTime?: string; endTime?: string };
    if (body.dayOfWeek === undefined || !body.startTime || !body.endTime) {
      throw new AppError(400, "MISSING_FIELDS", "dayOfWeek, startTime, and endTime are required");
    }
    const data = await createWeeklySlot(fastify, req.user.sub, body.dayOfWeek, body.startTime, body.endTime);
    reply.status(201).send({ data });
  });

  fastify.delete("/admin/weekly-slots/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteWeeklySlot(fastify, id);
    reply.send({ data: { deleted: true } });
  });

  // Credits
  fastify.get("/admin/students/:id/credits", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send({ data: await listStudentCredits(fastify, id) });
  });

  fastify.post("/admin/students/:id/credits", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      productId?: string;
      totalCredits?: number;
      paymentMethod?: string;
      expiresAt?: string;
      notes?: string;
    };
    if (!body.productId || !body.totalCredits || !body.paymentMethod) {
      throw new AppError(400, "MISSING_FIELDS", "productId, totalCredits, and paymentMethod are required");
    }
    const data = await grantCreditsToStudent(fastify, id, {
      productId: body.productId,
      totalCredits: body.totalCredits,
      paymentMethod: body.paymentMethod,
      grantedBy: req.user.sub as string,
      expiresAt: body.expiresAt,
      notes: body.notes,
    });
    reply.status(201).send({ data });
  });

  // Admin book on behalf of student
  fastify.get("/admin/students/:id/active-credits", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send({ data: await listStudentActiveCredits(fastify, id) });
  });

  fastify.post("/admin/students/:id/book", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { slotId, creditId } = (req.body ?? {}) as { slotId?: string; creditId?: string };
    if (!slotId || !creditId) throw new AppError(400, "MISSING_FIELDS", "slotId and creditId are required");
    const data = await adminBookForStudent(fastify, id, { slotId, creditId });
    reply.status(201).send({ data });
  });

  // Available slots (reused from schedule module)
  fastify.get("/admin/slots", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await getAvailableSlots(fastify) });
  });
}
