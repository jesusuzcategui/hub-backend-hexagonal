import { z } from "zod";

// A currency string is not restricted to a fixed enum here (unlike checkout's old
// COP/USD-only flow) because class-credit-plan carts may need broader gateway support
// later via hexagonal-payments-core; keep it loose but shaped.
const currencySchema = z.string().length(3).toUpperCase();

// Public shape only — items on POST /cart and PATCH /cart/:token (both
// no-auth) are priced strictly from the real product row (priceCartItems
// looks planId up in the products table). customAmountMinor/customLabel
// deliberately do NOT exist here: that pair lets an item skip the product
// price lookup entirely, so if a caller could set it through this schema
// they could name their own price on a public, unauthenticated endpoint.
// The admin-only custom-charge path (createCheckoutLink) uses a separate,
// non-public AdminCartItem type instead — see cart.service.ts.
export const cartItemSchema = z.object({
  planId: z.string().min(1),
  qty: z.number().int().min(1),
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
