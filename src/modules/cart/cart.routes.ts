import { FastifyInstance } from "fastify";
import {
  getCartController,
  addItemController,
  removeItemController,
  clearCartController,
} from "./cart.controller";

export async function cartRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/cart", { preHandler: fastify.authenticate }, getCartController);
  fastify.post("/cart/items", { preHandler: fastify.authenticate }, addItemController);
  fastify.delete("/cart/items/:productId", { preHandler: fastify.authenticate }, removeItemController);
  fastify.delete("/cart", { preHandler: fastify.authenticate }, clearCartController);
}
