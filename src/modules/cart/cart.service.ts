import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { carts } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import { escapeHtml } from "../payments/payments.service";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template";
import type { CartItem, CreateCartInput, UpdateCartInput } from "./cart.schemas";

// Admin-only — never accepted from a request body/zod schema (see the
// warning on cartItemSchema in cart.schemas.ts). Only admin.service.ts's
// createCheckoutLink constructs this, in trusted server code, never from
// user input.
export interface AdminCartItem {
  planId: string;
  qty: number;
  customAmountMinor?: number;
  customLabel?: string;
}

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
  input: Omit<CreateCartInput, "items"> & { items?: CreateCartInput["items"] | AdminCartItem[] },
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

/**
 * Emails the buyer their own cart link — public/no-auth, callable with just
 * the token (which the caller must already have, same trust model as every
 * other /cart/:token route). Used by the self-service /pricing flow so a
 * buyer who doesn't finish paying right away still has the link in their
 * inbox; mirrors admin.service.ts's createCheckoutLink email but kept
 * separate to avoid that one firing twice when an admin generates a link.
 */
export async function sendCartLinkEmail(fastify: FastifyInstance, token: string): Promise<void> {
  const cart = await getCartByToken(fastify, token);
  if (!cart.buyerEmail) throw new AppError(400, "MISSING_BUYER_EMAIL", "Cart has no buyer email");
  if (cart.status !== "open") return;

  const locale = cart.locale === "en" ? "en" : "es";
  const origin = (env.mentoring.portfolioOrigin ?? "https://jesusuzcategui.com").replace(/\/+$/, "");
  const path = locale === "en" ? `/en/cart/${cart.token}` : `/cart/${cart.token}`;
  const checkoutUrl = `${origin}${path}`;

  const subject = locale === "en" ? "Your payment link" : "Tu enlace de pago";
  const buttonLabel = locale === "en" ? "Complete purchase" : "Completar compra";
  const safeUrl = escapeHtml(checkoutUrl);
  const safeName = escapeHtml(cart.buyerName ?? cart.buyerEmail);

  const bodyHtml = locale === "en"
    ? `
      <p>Hi ${safeName},</p>
      <p>Here's your payment link — pick a payment method and finish your purchase whenever you're ready:</p>
      <p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${buttonLabel}</a></p>
      <p style="color:#8a939c; font-size:13px;">${safeUrl}</p>
    `
    : `
      <p>Hola ${safeName},</p>
      <p>Acá tenés tu enlace de pago — elegí tu método de pago y completá la compra cuando quieras:</p>
      <p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${buttonLabel}</a></p>
      <p style="color:#8a939c; font-size:13px;">${safeUrl}</p>
    `;

  await fastify.mailer.sendMail({
    from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
    to: cart.buyerEmail,
    subject,
    html: renderEmailHtml({ title: subject, bodyHtml, locale }),
  });
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
