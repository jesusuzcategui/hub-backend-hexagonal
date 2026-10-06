import { FastifyRequest, FastifyReply } from "fastify";
import { listProducts, listProductsForAdmin, getProductBySlug, syncAllProducts } from "./products.service";

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

export async function listProductsForAdminController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listProductsForAdmin(request.server);
  reply.status(200).send({ data });
}

export async function syncAllController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const count = await syncAllProducts(request.server);
  reply.status(200).send({ data: { synced: count } });
}

// WordPress webhook: POST /webhooks/wp. The body is ignored; any valid call triggers a full sync.
export async function wpWebhookController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const synced = await syncAllProducts(request.server);
  reply.status(200).send({ ok: true, synced });
}
