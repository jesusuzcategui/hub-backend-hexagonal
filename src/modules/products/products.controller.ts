import { FastifyRequest, FastifyReply } from "fastify";
import { listProducts, getProductBySlug, syncProductFromStrapi, syncAllProducts } from "./products.service";
import { AppError } from "../../lib/errors";
import type { StrapiProduct } from "../../lib/strapi";

export async function listProductsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listProducts(request.server);
  reply.status(200).send({ data });
}

export async function getProductController(
  request: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const product = await getProductBySlug(request.server, request.params.slug);
  reply.status(200).send({ data: product });
}

export async function syncAllController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const count = await syncAllProducts(request.server);
  reply.status(200).send({ data: { synced: count } });
}

// Strapi webhook: POST /webhooks/strapi
export async function strapiWebhookController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as {
    event: string;
    uid: string;
    entry: StrapiProduct;
  };

  if (body.uid !== "api::product.product") {
    reply.status(200).send({ ok: true });
    return;
  }

  switch (body.event) {
    case "entry.create":
    case "entry.update":
    case "entry.publish":
      await syncProductFromStrapi(request.server, body.entry);
      break;

    case "entry.unpublish":
    case "entry.delete": {
      const db = request.server.drizzle;
      const { products } = await import("../../db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(products)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(products.strapiDocumentId, body.entry.documentId));
      break;
    }

    default:
      break;
  }

  reply.status(200).send({ ok: true });
}
