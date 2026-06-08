import { timingSafeEqual } from "crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import {
  listProductsController,
  getProductController,
  syncAllController,
  strapiWebhookController,
} from "./products.controller";

async function requireAdmin(
  request: Parameters<typeof listProductsController>[0],
  reply: Parameters<typeof listProductsController>[1],
) {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin access required");
  }
}

async function verifyStrapiSecret(request: FastifyRequest, reply: FastifyReply) {
  const provided = request.headers["x-strapi-signature"] as string | undefined;
  const expected = env.strapi.webhookSecret;

  if (!provided) {
    reply.status(401).send({ error: { code: "MISSING_SIGNATURE", message: "Missing webhook signature" } });
    return;
  }

  try {
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } });
    }
  } catch {
    reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } });
  }
}

export async function productsRoutes(fastify: FastifyInstance): Promise<void> {
  // Public
  fastify.get("/products", listProductsController);
  fastify.get("/products/:slug", getProductController);

  // Strapi webhook — verified by shared secret header X-Strapi-Signature
  fastify.post("/webhooks/strapi", { preHandler: verifyStrapiSecret }, strapiWebhookController);

  // Admin: manual sync
  fastify.post(
    "/admin/products/sync",
    { preHandler: [fastify.authenticate, requireAdmin] },
    syncAllController,
  );
}
