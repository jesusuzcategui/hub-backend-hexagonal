import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { rateLimitedError } from "../../lib/errors";
import { rateLimitStoreOptions } from "../../lib/cache";
import { bookSlotSchema, submitReviewSchema } from "./portfolio.schemas.js";
import { createMentoringRequest, getPublicSlots, submitReview } from "./portfolio.service.js";
import { AppError } from "../../lib/errors.js";
import { verifyCaptchaToken } from "./portfolio.captcha.js";

export async function portfolioRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rateLimit, {
    ...rateLimitStoreOptions(fastify, "portfolio"),
    max: 20,
    timeWindow: "5 minutes",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: rateLimitedError,
  });

  fastify.get("/public/slots", async (_req, reply) => {
    const slots = await getPublicSlots(fastify);
    reply.send({ data: slots });
  });

  fastify.post("/public/book", async (req, reply) => {
    const parsed = bookSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
    }

    // Validate captcha token
    await verifyCaptchaToken(parsed.data.captchaToken);

    const result = await createMentoringRequest(fastify, parsed.data);
    reply.code(201).send({ data: result });
  });

  fastify.post("/public/reviews", async (req, reply) => {
    const parsed = submitReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
    }

    try {
      await submitReview(parsed.data);
      reply.code(201).send({ data: { ok: true } });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      const msg = err instanceof Error ? err.message : "Submission failed";
      reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: msg } });
    }
  });
}
