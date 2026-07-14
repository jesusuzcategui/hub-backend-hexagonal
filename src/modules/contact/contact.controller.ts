import type { FastifyRequest, FastifyReply } from "fastify";
import { contactSchema } from "./contact.schemas.js";
import { sendContactEmail } from "./contact.service.js";
import { verifyCaptchaToken } from "../portfolio/portfolio.captcha.js";

export async function contactController(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = contactSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() },
    });
  }

  try {
    // Validate captcha token
    await verifyCaptchaToken(parsed.data.captchaToken);

    await sendContactEmail(request.server, parsed.data);
    return reply.status(200).send({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Contact submission failed";
    const code = msg.includes("Captcha") ? 400 : 500;
    return reply.status(code).send({ error: msg });
  }
}
