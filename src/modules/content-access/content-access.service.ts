import { and, eq, gt, isNull, or } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { contentAccess, products } from "../../db/schema";

export async function checkContentAccess(
  fastify: FastifyInstance,
  userId: string,
  contentType: string,
  externalId: string,
): Promise<boolean> {
  const now = new Date();
  const record = await fastify.drizzle.query.contentAccess.findFirst({
    where: and(
      eq(contentAccess.userId, userId),
      eq(contentAccess.contentType, contentType),
      eq(contentAccess.externalId, externalId),
      isNull(contentAccess.revokedAt),
      or(isNull(contentAccess.validUntil), gt(contentAccess.validUntil, now)),
    ),
    columns: { id: true },
  });

  return !!record;
}

export async function listUserAccess(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle.query.contentAccess.findMany({
    where: and(eq(contentAccess.userId, userId), isNull(contentAccess.revokedAt)),
    columns: {
      id: true,
      contentType: true,
      externalId: true,
      reason: true,
      orderId: true,
      validFrom: true,
      validUntil: true,
      createdAt: true,
    },
    orderBy: (a, { desc }) => [desc(a.createdAt)],
  });
}

export async function grantContentAccess(
  fastify: FastifyInstance,
  { userId, orderId, productId }: { userId: string; orderId: string; productId: string },
): Promise<void> {
  const product = await fastify.drizzle.query.products.findFirst({
    where: eq(products.id, productId),
    columns: { externalId: true, contentType: true },
  });

  if (!product) return;

  await fastify.drizzle
    .insert(contentAccess)
    .values({
      userId,
      contentType: product.contentType,
      externalId: product.externalId,
      reason: "order",
      orderId,
    })
    .onConflictDoNothing();
}
