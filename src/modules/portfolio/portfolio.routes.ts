import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { bookSlotSchema } from "./portfolio.schemas.js";
import { createMentoringRequest, getPublicSlots } from "./portfolio.service.js";

export async function portfolioRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rateLimit, {
    max: 20,
    timeWindow: "5 minutes",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    }),
  });

  fastify.get("/public/slots", async (_req, reply) => {
    const slots = await getPublicSlots(fastify);
    reply.send({ data: slots });
  });

  fastify.post("/public/book", async (req, reply) => {
    const parsed = bookSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() },
      });
    }

    try {
      const result = await createMentoringRequest(fastify, parsed.data);
      reply.code(201).send({ data: result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Booking failed";
      const code = msg.includes("already booked") ? 409 : msg.includes("not found") ? 404 : 400;
      reply.code(code).send({ error: msg });
    }
  });
}
