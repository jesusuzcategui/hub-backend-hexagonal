import { FastifyInstance } from "fastify";
import { AppError } from "../../lib/errors";
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

export async function productsRoutes(fastify: FastifyInstance): Promise<void> {
  // Public
  fastify.get("/products", listProductsController);
  fastify.get("/products/:slug", getProductController);

  // Strapi webhook (no auth — secured by payload validation in controller)
  fastify.post("/webhooks/strapi", strapiWebhookController);

  // Admin: manual sync
  fastify.post(
    "/admin/products/sync",
    { preHandler: [fastify.authenticate, requireAdmin] },
    syncAllController,
  );
}
