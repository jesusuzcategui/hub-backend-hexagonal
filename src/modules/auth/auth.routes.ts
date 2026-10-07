import { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { rateLimitStoreOptions } from "../../lib/cache";
import {
  registerController,
  loginController,
  refreshController,
  logoutController,
  meController,
  forgotPasswordController,
  resetPasswordController,
} from "./auth.controller";

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/auth/register", registerController);
  fastify.post("/auth/login", loginController);
  fastify.post("/auth/refresh", refreshController);
  fastify.post("/auth/logout", logoutController);
  fastify.get("/auth/me", { preHandler: fastify.authenticate }, meController);

  // Scoped rate limit — /forgot-password sends an email per hit, so it's
  // the one auth route where an unthrottled attacker can both spam a
  // victim's inbox and burn SMTP quota. Encapsulated plugin context keeps
  // this off the rest of /auth/*.
  await fastify.register(async (scoped) => {
    await scoped.register(rateLimit, {
      ...rateLimitStoreOptions(scoped, "auth"),
      max: 5,
      timeWindow: "15 minutes",
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: () => ({
        error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      }),
    });
    scoped.post("/auth/forgot-password", forgotPasswordController);
  });

  fastify.post("/auth/reset-password", resetPasswordController);
}
