import { z } from "zod";
import { OrderKindRegistry } from "hexagonal-payments-core";

// Metadata shape for the (currently only) order kind this app creates: a class-credit
// plan purchase originating from the public cart/checkout flow. `creditsCount` is what
// the webhook/admin settlement side-effect reads to know how many class credits to
// grant (mirrors admin.service.ts's grantCreditsToStudent) — ASSUMPTION: this is the
// simplest metadata shape that carries everything the settlement side-effect and the
// confirmation email need without re-deriving it from the cart (which may have since
// been mutated/expired). `locale` is carried here because the core's `Order` has no
// locale field of its own (see payments.service.ts's checkout()).
export const classCreditPlanMetadataSchema = z.object({
  cartId: z.string().uuid(),
  productId: z.string().uuid(),
  creditsCount: z.number().int().min(1),
  locale: z.enum(["en", "es"]).default("es"),
  couponId: z.string().uuid().nullable().default(null),
  couponCode: z.string().nullable().default(null),
  items: z.array(z.object({ planId: z.string(), qty: z.number().int().min(1) })),
});

export type ClassCreditPlanMetadata = z.infer<typeof classCreditPlanMetadataSchema>;

export const CLASS_CREDIT_PLAN_KIND = "class_credit_plan";
export const CLASS_CREDIT_PLAN_VERSION = 1;

let registry: OrderKindRegistry | null = null;

/** Singleton — the registry is pure/in-memory, safe to share across requests. */
export function getOrderKindRegistry(): OrderKindRegistry {
  if (!registry) {
    registry = new OrderKindRegistry();
    registry.register(CLASS_CREDIT_PLAN_KIND, CLASS_CREDIT_PLAN_VERSION, classCreditPlanMetadataSchema);
  }
  return registry;
}
