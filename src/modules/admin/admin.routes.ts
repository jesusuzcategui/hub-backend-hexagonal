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
  markAttendance,
  listAvailabilities,
  createAvailability,
  deleteAvailability,
  listWeeklySlots,
  createWeeklySlot,
  deleteWeeklySlot,
  deactivateWeeklySlot,
  reactivateWeeklySlot,
  listStudentCredits,
  grantCreditsToStudent,
  listStudentActiveCredits,
  adminBookForStudent,
  getAvailableSlots,
  listOrders,
  validateTransfer,
  getOrderDetail,
  getOrderProof,
  listCoupons,
  createCoupon,
  deactivateCoupon,
  reactivateCoupon,
  rescheduleBooking,
  listBlockedSlots,
  createBlockedSlot,
  deleteBlockedSlot,
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

  fastify.patch(
    "/admin/bookings/:id/attendance",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { attended } = (req.body ?? {}) as { attended?: boolean };
      if (typeof attended !== "boolean") {
        throw new AppError(400, "MISSING_FIELDS", "attended (boolean) is required");
      }
      reply.send({ data: await markAttendance(fastify, id, attended) });
    },
  );

  fastify.patch(
    "/admin/bookings/:id/reschedule",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { newSlotId } = (req.body ?? {}) as { newSlotId?: string };
      if (!newSlotId) throw new AppError(400, "MISSING_FIELDS", "newSlotId is required");
      reply.send({ data: await rescheduleBooking(fastify, id, newSlotId) });
    },
  );

  // Blocked slots (teacher unavailability — vacation, one-off blocks)
  fastify.get("/admin/blocked-slots", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await listBlockedSlots(fastify) });
  });

  fastify.post("/admin/blocked-slots", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as { startsAt?: string; endsAt?: string; reason?: string };
    if (!body.startsAt || !body.endsAt) throw new AppError(400, "MISSING_FIELDS", "startsAt and endsAt are required");
    const data = await createBlockedSlot(fastify, {
      teacherId: req.user.sub as string,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      reason: body.reason,
    });
    reply.status(201).send({ data });
  });

  fastify.delete("/admin/blocked-slots/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteBlockedSlot(fastify, id);
    reply.send({ data: { deleted: true } });
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

  fastify.patch("/admin/weekly-slots/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { isActive?: boolean };
    if (typeof body.isActive !== "boolean") {
      throw new AppError(400, "MISSING_FIELDS", "isActive is required and must be a boolean");
    }
    const data = body.isActive
      ? await reactivateWeeklySlot(fastify, id)
      : await deactivateWeeklySlot(fastify, id);
    reply.send({ data });
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

  // Orders (payments module)
  fastify.get("/admin/orders", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { status, fulfillmentStatus } = req.query as { status?: string; fulfillmentStatus?: string };
    reply.send({ data: await listOrders(fastify, { status, fulfillmentStatus }) });
  });

  fastify.post(
    "/admin/orders/:id/validate-transfer",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { decision } = (req.body ?? {}) as { decision?: "approve" | "reject" };
      if (decision !== "approve" && decision !== "reject") {
        throw new AppError(400, "INVALID_DECISION", "decision must be approve or reject");
      }
      const result = await validateTransfer(fastify, id, decision);
      reply.send({ data: { outcome: result.outcome } });
    },
  );

  fastify.get("/admin/orders/:id", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send({ data: await getOrderDetail(fastify, id) });
  });

  fastify.get("/admin/orders/:id/proof", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { buffer, filename, contentType, inline } = await getOrderProof(fastify, id);
    reply
      .header("Content-Type", contentType)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`)
      .send(buffer);
  });

  // Coupons
  fastify.get("/admin/coupons", { preHandler: [fastify.authenticate, requireAdmin] }, async (_req, reply) => {
    reply.send({ data: await listCoupons(fastify) });
  });

  fastify.post("/admin/coupons", { preHandler: [fastify.authenticate, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      code?: string;
      type?: "percent" | "fixed";
      value?: number;
      currency?: string;
      maxRedemptions?: number;
      expiresAt?: string;
    };
    if (!body.code || !body.type || body.value === undefined) {
      throw new AppError(400, "MISSING_FIELDS", "code, type, and value are required");
    }
    if (body.type !== "percent" && body.type !== "fixed") {
      throw new AppError(400, "INVALID_TYPE", "type must be percent or fixed");
    }
    const data = await createCoupon(fastify, {
      code: body.code,
      type: body.type,
      value: body.value,
      currency: body.currency ?? null,
      maxRedemptions: body.maxRedemptions ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    reply.status(201).send({ data });
  });

  fastify.post(
    "/admin/coupons/:id/deactivate",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.send({ data: await deactivateCoupon(fastify, id) });
    },
  );

  fastify.post(
    "/admin/coupons/:id/reactivate",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.send({ data: await reactivateCoupon(fastify, id) });
    },
  );
}
