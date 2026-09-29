import { z } from "zod";

// A currency string is not restricted to a fixed enum here (unlike checkout's old
// COP/USD-only flow) because class-credit-plan carts may need broader gateway support
// later via hexagonal-payments-core; keep it loose but shaped.
const currencySchema = z.string().length(3).toUpperCase();

// A "custom" item has no real product behind it — an ad-hoc charge (e.g. an
// outstanding balance, a one-off fee) an admin wants to collect via the same
// checkout-link flow. customAmountMinor/customLabel carry the price and the
// text a buyer sees for it instead of a product lookup; planId is still
// required as the schema's discriminant-free key (checkout.ts treats a
// non-empty customAmountMinor as "this item is custom" — see priceCartItems).
export const cartItemSchema = z.object({
  planId: z.string().min(1),
  qty: z.number().int().min(1),
  customAmountMinor: z.number().int().positive().optional(),
  customLabel: z.string().trim().min(1).max(200).optional(),
});

export const createCartSchema = z.object({
  items: z.array(cartItemSchema).optional().default([]),
  buyerEmail: z.string().email().optional(),
  buyerName: z.string().min(1).optional(),
  buyerWhatsapp: z.string().min(1).optional(),
  currency: currencySchema.optional(),
  locale: z.enum(["en", "es"]).optional(),
});

export const updateCartSchema = z.object({
  items: z.array(cartItemSchema).optional(),
  buyerEmail: z.string().email().nullable().optional(),
  buyerName: z.string().min(1).nullable().optional(),
  buyerWhatsapp: z.string().min(1).nullable().optional(),
  currency: currencySchema.nullable().optional(),
  locale: z.enum(["en", "es"]).nullable().optional(),
});

export type CreateCartInput = z.infer<typeof createCartSchema>;
export type UpdateCartInput = z.infer<typeof updateCartSchema>;
export type CartItem = z.infer<typeof cartItemSchema>;
