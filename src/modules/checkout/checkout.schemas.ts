import { z } from "zod";

export const createCheckoutSchema = z.object({
  productId: z.string().uuid(),
  currency: z.enum(["COP", "USD"]),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
