import { FastifyRequest, FastifyReply } from "fastify";
import { listUserPayments } from "./payments.service";

export async function listPaymentsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listUserPayments(request.server, request.user.sub);
  reply.send({ data });
}
