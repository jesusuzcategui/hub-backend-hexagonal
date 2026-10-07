import type { FastifyInstance } from "fastify";
import { AppError } from "../../lib/errors.js";
import {
  cancelStudentBooking,
  createStudentBooking,
  getAvailableSlots,
  getStudentCredits,
  listStudentBookings,
  rescheduleStudentBooking,
} from "./schedule.service.js";
import { cancelSeries, createSeriesIdempotent, listSeries, previewSeries } from "./series.service.js";
import { parseIdempotencyKey, splitSeriesRequest } from "./series.js";

export async function scheduleRoutes(fastify: FastifyInstance) {
  fastify.get("/schedule/slots", {
    preHandler: [fastify.authenticate],
    handler: async (_req, reply) => {
      const slots = await getAvailableSlots(fastify);
      reply.send({ data: slots });
    },
  });

  fastify.get("/schedule/credits", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const summary = await getStudentCredits(fastify, req.user.sub as string);
      // `data` keeps the legacy array shape the campus reads; balance/nextExpiry/blocks are additive.
      reply.send({ data: summary.blocks, balance: summary.balance, nextExpiry: summary.nextExpiry, blocks: summary.blocks });
    },
  });

  fastify.get("/schedule/my", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const bookingList = await listStudentBookings(fastify, req.user.sub as string);
      reply.send({ data: bookingList });
    },
  });

  fastify.post("/schedule/book", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const { slotId, creditId, notes } = req.body as {
        slotId: string;
        creditId?: string;
        notes?: string;
      };

      if (!slotId) {
        return reply.code(400).send({ error: "slotId required" });
      }

      try {
        const result = await createStudentBooking(fastify, {
          studentId: req.user.sub as string,
          slotId,
          creditId,
          notes,
        });
        reply.code(201).send({ data: result });
      } catch (err: unknown) {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        const msg = err instanceof Error ? err.message : "Booking failed";
        const code =
          msg.includes("already booked") || msg.includes("No credits") ? 409 : 400;
        reply.code(code).send({ error: msg });
      }
    },
  });

  fastify.delete("/schedule/my/:id", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await cancelStudentBooking(fastify, id, req.user.sub as string);
        reply.send({ success: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cancel failed";
        const code = msg.includes("not found") ? 404 : 400;
        reply.code(code).send({ error: msg });
      }
    },
  });

  fastify.patch("/schedule/my/:id/reschedule", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { newSlotId } = req.body as { newSlotId?: string };
      if (!newSlotId) return reply.code(400).send({ error: "newSlotId required" });

      try {
        const result = await rescheduleStudentBooking(fastify, {
          bookingId: id,
          studentId: req.user.sub as string,
          newSlotId,
        });
        reply.send({ data: result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Reschedule failed";
        const code = msg.includes("not found") ? 404 : msg.includes("already booked") || msg.includes("blocked") ? 409 : 400;
        reply.code(code).send({ error: msg });
      }
    },
  });

  // ---- Recurring series (students act only on their own series; the id always comes from the token) ----
  fastify.post("/schedule/series/preview", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const { rule } = splitSeriesRequest(req.body);
      reply.send({ data: await previewSeries(fastify, { studentId: req.user.sub as string, rule }) });
    },
  });

  fastify.post("/schedule/series", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);
      const { rule, skipConflicts } = splitSeriesRequest(req.body);
      const userId = req.user.sub as string;
      const { result, replayed } = await createSeriesIdempotent(fastify, { studentId: userId, createdBy: userId, rule, skipConflicts, idempotencyKey });
      if (replayed) reply.header("Idempotent-Replayed", "true");
      reply.code(replayed ? 200 : 201).send({ data: result });
    },
  });

  fastify.get("/schedule/series", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      reply.send({ data: await listSeries(fastify, req.user.sub as string) });
    },
  });

  fastify.delete("/schedule/series/:id", {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.send({ data: await cancelSeries(fastify, { seriesId: id, actor: { role: "student", userId: req.user.sub as string } }) });
    },
  });
}
