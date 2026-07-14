import { z } from "zod";

export const bookSlotSchema = z
  .object({
    slotId: z.string().min(1),
    name: z.string().min(2).max(120),
    email: z.string().email(),
    whatsapp: z.string().min(7).max(20).regex(/^\+?[\d\s\-(). ]+$/, "Invalid phone number"),
    type: z.enum(["wordpress", "shopify", "custom", "quote"]),
    message: z.string().max(1000).refine(
      (v) => !/<[a-z!\/]/i.test(v),
      "Invalid characters in message"
    ).optional(),
    locale: z.enum(["es", "en"]).optional().default("es"),
    website: z.string().max(0).optional(), // honeypot
    captchaToken: z.string().optional(),
  })
  .refine((d) => !d.website, { message: "bot detected" });

export type BookSlotBody = z.infer<typeof bookSlotSchema>;

export const submitReviewSchema = z
  .object({
    author_name: z.string().min(2).max(120).trim(),
    rating: z.number().min(1).max(5),
    message: z.string().min(10).max(2000).refine(
      (v) => !/<[a-z!\/]/i.test(v),
      "Invalid characters in message"
    ),
    website: z.string().max(0).optional(), // honeypot
  })
  .refine((d) => !d.website, { message: "bot detected" });

export type SubmitReviewBody = z.infer<typeof submitReviewSchema>;
