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
    priceCop: p.priceCOP,
    priceUsd: p.priceUSD,
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
