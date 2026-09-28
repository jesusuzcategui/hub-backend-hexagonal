import { FastifyInstance } from "fastify";
import { createCartController, getCartController, updateCartController } from "./cart.controller";

// Public, no-auth: buyers have no account yet at cart stage. The cart's `id`
// (returned as `token`) is the opaque bearer credential used in the URL.
export async function cartRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/cart", createCartController);
  fastify.get("/cart/:token", getCartController);
  fastify.patch("/cart/:token", updateCartController);
}
