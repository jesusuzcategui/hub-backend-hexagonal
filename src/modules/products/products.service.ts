import { eq, notInArray } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { products } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { fetchWpProducts, WP_PRODUCT_CONTENT_TYPE, type WpProduct } from "../../lib/wp";

function mapWpToDb(p: WpProduct) {
  return {
    externalId: p.externalId,
    contentType: WP_PRODUCT_CONTENT_TYPE,
    slug: p.slug,
    name: p.name,
    description: p.description,
    // priceCop is stored as amountMinor directly (COP has no minor unit).
    // priceUsd is already in cents (see wp.ts), matching USD's exponent of 2.
    priceCop: p.priceCop,
    priceUsd: p.priceUsd,
    isActive: p.isActive,
    metadata: p.metadata,
    updatedAt: new Date(),
  };
}

export async function syncProductFromWp(fastify: FastifyInstance, wpProduct: WpProduct): Promise<void> {
  const values = mapWpToDb(wpProduct);

  await fastify.drizzle
    .insert(products)
    .values(values)
    .onConflictDoUpdate({ target: products.externalId, set: values });
}

/**
 * Upserts every valid product from the WP feed and deactivates the products
 * that are no longer in it. An empty feed deactivates nothing, so a broken or
 * misconfigured WP cannot take the whole shop offline.
 */
export async function syncAllProducts(
  fastify: FastifyInstance,
  fetchProducts: () => Promise<WpProduct[]> = fetchWpProducts,
): Promise<number> {
  const wpProducts = await fetchProducts();
  if (wpProducts.length === 0) return 0;

  await Promise.all(wpProducts.map((p) => syncProductFromWp(fastify, p)));

  await fastify.drizzle
    .update(products)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      notInArray(
        products.externalId,
        wpProducts.map((p) => p.externalId),
      ),
    );

  return wpProducts.length;
}

export async function listProducts(fastify: FastifyInstance) {
  return fastify.drizzle.query.products.findMany({
    where: eq(products.isActive, true),
    columns: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceCop: true,
      priceUsd: true,
      metadata: true,
    },
    orderBy: (p, { asc }) => [asc(p.priceCop)],
  });
}

// Admin: every product (active + inactive/unpublished), with sync
// provenance — updatedAt doubles as "last synced from WordPress" since every
// sync path (webhook or manual) touches it, and there's no separate
// sync-log table to maintain.
export async function listProductsForAdmin(fastify: FastifyInstance) {
  return fastify.drizzle.query.products.findMany({
    columns: {
      id: true,
      slug: true,
      name: true,
      priceCop: true,
      priceUsd: true,
      isActive: true,
      externalId: true,
      updatedAt: true,
    },
    orderBy: (p, { desc }) => [desc(p.updatedAt)],
  });
}

export async function getProductBySlug(fastify: FastifyInstance, slug: string) {
  const product = await fastify.drizzle.query.products.findFirst({
    where: eq(products.slug, slug),
    columns: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceCop: true,
      priceUsd: true,
      metadata: true,
      isActive: true,
    },
  });

  if (!product || !product.isActive) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  }

  return product;
}
