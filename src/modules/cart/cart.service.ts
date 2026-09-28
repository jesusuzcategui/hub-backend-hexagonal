import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { carts } from "../../db/schema";
import { AppError } from "../../lib/errors";
import type { CartItem, CreateCartInput, UpdateCartInput } from "./cart.schemas";

export interface CartDto {
  token: string;
  items: CartItem[];
  buyerEmail: string | null;
  buyerName: string | null;
  buyerWhatsapp: string | null;
  currency: string | null;
  locale: string | null;
  status: "open" | "converted" | "abandoned";
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

type CartRow = typeof carts.$inferSelect;

function toDto(row: CartRow): CartDto {
  return {
    token: row.id,
    items: (row.items as CartItem[]) ?? [],
    buyerEmail: row.buyerEmail,
    buyerName: row.buyerName,
    buyerWhatsapp: row.buyerWhatsapp,
    currency: row.currency,
    locale: row.locale,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

export async function createCart(
  fastify: FastifyInstance,
  input: CreateCartInput,
): Promise<CartDto> {
  const [row] = await fastify.drizzle
    .insert(carts)
    .values({
      items: input.items ?? [],
      buyerEmail: input.buyerEmail ?? null,
      buyerName: input.buyerName ?? null,
      buyerWhatsapp: input.buyerWhatsapp ?? null,
      currency: input.currency ?? null,
      locale: input.locale ?? null,
    })
    .returning();

  return toDto(row);
}

export async function getCartByToken(
  fastify: FastifyInstance,
  token: string,
): Promise<CartDto> {
  const row = await fastify.drizzle.query.carts.findFirst({
    where: eq(carts.id, token),
  });

  if (!row) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");

  // A converted/abandoned cart is returned as-is (not 404'd) so a recovery-link
  // opened from an old email can tell the buyer "this cart already checked out"
  // instead of hitting a dead end; the frontend decides what to render off `status`.
  return toDto(row);
}

export async function updateCartByToken(
  fastify: FastifyInstance,
  token: string,
  input: UpdateCartInput,
): Promise<CartDto> {
  const db = fastify.drizzle;

  const existing = await db.query.carts.findFirst({
    where: eq(carts.id, token),
    columns: { id: true, status: true },
  });

  if (!existing) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");
  if (existing.status !== "open") {
    throw new AppError(409, "CART_NOT_OPEN", "Cannot edit a cart that is not open");
  }

  const updates: Partial<typeof carts.$inferInsert> = { updatedAt: new Date() };
  if (input.items !== undefined) updates.items = input.items;
  if (input.buyerEmail !== undefined) updates.buyerEmail = input.buyerEmail;
  if (input.buyerName !== undefined) updates.buyerName = input.buyerName;
  if (input.buyerWhatsapp !== undefined) updates.buyerWhatsapp = input.buyerWhatsapp;
  if (input.currency !== undefined) updates.currency = input.currency;
  if (input.locale !== undefined) updates.locale = input.locale;

  const [row] = await db.update(carts).set(updates).where(eq(carts.id, token)).returning();

  return toDto(row);
}
