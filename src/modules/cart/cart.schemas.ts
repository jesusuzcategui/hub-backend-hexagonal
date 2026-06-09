import { z } from "zod";

export const addItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
});
