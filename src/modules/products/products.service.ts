import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { products } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { fetchAllProducts, type StrapiProduct } from "../../lib/strapi";

function mapStrapiToDb(p: StrapiProduct) {
  return {
    strapiDocumentId: p.documentId,
    strapiContentType: "api::product.product",
    slug: p.slug,
    name: p.name,
    description: p.description ?? null,
    // priceCop is stored as amountMinor directly — correct as-is, since COP
    // has no minor unit (see money.ts's minorUnitExponent: COP exponent 0).
    // priceUsd must be cents to match USD's exponent of 2 (how it's later
    // used as amountMinor in priceCartItems/toDecimalMajor for PayPal), but
    // Strapi's priceUSD field is edited as whole dollars — convert here or
    // every USD charge undercharges 100x.
    priceCop: p.priceCOP,
    priceUsd: Math.round(p.priceUSD * 100),
    isActive: p.isActive,
    metadata: p.metadata ?? {},
    updatedAt: new Date(),
  };
}

export async function syncProductFromStrapi(
  fastify: FastifyInstance,
  strapiProduct: StrapiProduct,
): Promise<void> {
  const db = fastify.drizzle;

  await db
    .insert(products)
    .values({ ...mapStrapiToDb(strapiProduct) })
    .onConflictDoUpdate({
      target: products.strapiDocumentId,
      set: mapStrapiToDb(strapiProduct),
    });
}

export async function syncAllProducts(fastify: FastifyInstance): Promise<number> {
  const strapiProducts = await fetchAllProducts();
  await Promise.all(strapiProducts.map((p) => syncProductFromStrapi(fastify, p)));
  return strapiProducts.length;
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
// provenance — updatedAt doubles as "last synced from Strapi" since every
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
      strapiDocumentId: true,
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
