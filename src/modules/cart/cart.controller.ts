import { FastifyRequest, FastifyReply } from "fastify";
import { addItemSchema } from "./cart.schemas";
import { getCart, addCartItem, removeCartItem, clearCart } from "./cart.service";

export async function getCartController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const items = await getCart(request.server, request.user.sub);
  reply.send({ data: items });
}

export async function addItemController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = addItemSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } });
    return;
  }

  const items = await addCartItem(
    request.server,
    request.user.sub,
    parsed.data.productId,
    parsed.data.quantity,
  );
  reply.send({ data: items });
}

export async function removeItemController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { productId } = request.params as { productId: string };
  const items = await removeCartItem(request.server, request.user.sub, productId);
  reply.send({ data: items });
}

export async function clearCartController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await clearCart(request.server, request.user.sub);
  reply.send({ data: [] });
}
