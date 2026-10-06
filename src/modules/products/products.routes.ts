import { timingSafeEqual } from "crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import {
  listProductsController,
  listProductsForAdminController,
  getProductController,
  syncAllController,
  wpWebhookController,
} from "./products.controller";

async function requireAdmin(
  request: Parameters<typeof listProductsController>[0],
  reply: Parameters<typeof listProductsController>[1],
) {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin access required");
  }
}

async function verifyWpSecret(request: FastifyRequest, reply: FastifyReply) {
  const provided = request.headers["x-webhook-secret"];
  const expected = env.wp.webhookSecret;

  if (typeof provided !== "string" || provided === "") {
    return reply.status(401).send({ error: { code: "MISSING_SIGNATURE", message: "Missing webhook secret" } });
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook secret" } });
  }
}

export async function productsRoutes(fastify: FastifyInstance): Promise<void> {
  // Public
  fastify.get("/products", listProductsController);
  fastify.get("/products/:slug", getProductController);

  // WordPress webhook — verified by shared secret header X-Webhook-Secret
  fastify.post("/webhooks/wp", { preHandler: verifyWpSecret }, wpWebhookController);

  // Admin: manual sync
  fastify.post(
    "/admin/products/sync",
    { preHandler: [fastify.authenticate, requireAdmin] },
    syncAllController,
  );

  fastify.get(
    "/admin/products",
    { preHandler: [fastify.authenticate, requireAdmin] },
    listProductsForAdminController,
  );
}
