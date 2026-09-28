import { FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "../../lib/errors";
import { createCartSchema, updateCartSchema } from "./cart.schemas";
import { createCart, getCartByToken, updateCartByToken } from "./cart.service";

export async function createCartController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createCartSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues[0].message);
  }

  const cart = await createCart(request.server, parsed.data);
  reply.status(201).send({ data: cart });
}

export async function getCartController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { token } = request.params as { token: string };
  const cart = await getCartByToken(request.server, token);
  reply.send({ data: cart });
}

export async function updateCartController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { token } = request.params as { token: string };
  const parsed = updateCartSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues[0].message);
  }

  const cart = await updateCartByToken(request.server, token, parsed.data);
  reply.send({ data: cart });
}
