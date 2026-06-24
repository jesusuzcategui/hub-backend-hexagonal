import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { contactController } from "./contact.controller.js";

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rateLimit, {
    max: 3,
    timeWindow: "15 minutes",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    }),
  });

  fastify.post("/contact", contactController);
}
