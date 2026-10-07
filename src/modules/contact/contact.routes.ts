import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { rateLimitedError } from "../../lib/errors";
import { rateLimitStoreOptions } from "../../lib/cache";
import { contactController } from "./contact.controller.js";

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rateLimit, {
    ...rateLimitStoreOptions(fastify, "contact"),
    max: 3,
    timeWindow: "15 minutes",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: rateLimitedError,
  });

  fastify.post("/contact", contactController);
}
