import { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { rateLimitStoreOptions } from "../../lib/cache";
import { createCartController, getCartController, updateCartController, sendCartLinkController } from "./cart.controller";

// Public, no-auth: buyers have no account yet at cart stage. The cart's `id`
// (returned as `token`) is the opaque bearer credential used in the URL.
export async function cartRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/cart", createCartController);
  fastify.get("/cart/:token", getCartController);
  fastify.patch("/cart/:token", updateCartController);

  // Scoped rate limit — send-link emails per hit, same reasoning as
  // /auth/forgot-password (see auth.routes.ts).
  await fastify.register(async (scoped) => {
    await scoped.register(rateLimit, {
      ...rateLimitStoreOptions(scoped, "cart"),
      max: 5,
      timeWindow: "15 minutes",
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: () => ({
        error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      }),
    });
    scoped.post("/cart/:token/send-link", sendCartLinkController);
  });
}
