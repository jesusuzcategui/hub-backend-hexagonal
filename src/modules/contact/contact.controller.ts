import type { FastifyRequest, FastifyReply } from "fastify";
import { contactSchema } from "./contact.schemas.js";
import { sendContactEmail } from "./contact.service.js";

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

  await sendContactEmail(request.server, parsed.data);
  return reply.status(200).send({ ok: true });
}
