import type { FastifyInstance } from "fastify";
import {
  cancelStudentBooking,
  createStudentBooking,
  getAvailableSlots,
  getStudentCredits,
  listStudentBookings,
} from "./schedule.service.js";

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
      const credits = await getStudentCredits(fastify, req.user.sub as string);
      reply.send({ data: credits });
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
        creditId: string;
        notes?: string;
      };

      if (!slotId || !creditId) {
        return reply.code(400).send({ error: "slotId and creditId required" });
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
}
