import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { products } from "../../db/schema";
import { AppError } from "../../lib/errors";

const CART_TTL = 7 * 24 * 60 * 60;

function cartKey(userId: string): string {
  return `cart:${userId}`;
}

export interface CartItem {
  productId: string;
  name: string;
  priceCop: number;
  priceUsd: number;
  quantity: number;
  addedAt: string;
}

export async function getCart(fastify: FastifyInstance, userId: string): Promise<CartItem[]> {
  const raw = await fastify.redis.hgetall(cartKey(userId));
  if (!raw || Object.keys(raw).length === 0) return [];
  return Object.values(raw).map((v) => JSON.parse(v) as CartItem);
}

export async function addCartItem(
  fastify: FastifyInstance,
  userId: string,
  productId: string,
  quantity: number,
): Promise<CartItem[]> {
  const product = await fastify.drizzle.query.products.findFirst({
    where: eq(products.id, productId),
    columns: { id: true, name: true, priceCop: true, priceUsd: true, isActive: true },
  });

  if (!product || !product.isActive) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  }

  const key = cartKey(userId);
  const item: CartItem = {
    productId: product.id,
    name: product.name,
    priceCop: product.priceCop,
    priceUsd: product.priceUsd,
    quantity,
    addedAt: new Date().toISOString(),
  };

  await fastify.redis.hset(key, productId, JSON.stringify(item));
  await fastify.redis.expire(key, CART_TTL);

  return getCart(fastify, userId);
}

export async function removeCartItem(
  fastify: FastifyInstance,
  userId: string,
  productId: string,
): Promise<CartItem[]> {
  await fastify.redis.hdel(cartKey(userId), productId);
  return getCart(fastify, userId);
}

export async function clearCart(fastify: FastifyInstance, userId: string): Promise<void> {
  await fastify.redis.del(cartKey(userId));
}
