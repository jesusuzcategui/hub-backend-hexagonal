import { z } from "zod";

export const contactSchema = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
    message: z.string().min(1).max(5000),
    projectType: z.enum(["e-commerce", "website", "web-app", "consultancy"]),
    budget: z.enum(["500-2k", "2k-5k", "5k-10k", "10k-25k", "25k+"]),
    // honeypot — must be empty; bots fill it, humans skip it
    website: z.string().max(0).optional(),
  })
  .refine((d) => !d.website, { message: "bot detected" });

export type ContactBody = z.infer<typeof contactSchema>;
