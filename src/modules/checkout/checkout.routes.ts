import { FastifyInstance } from "fastify";
import {
  createCheckoutController,
  listOrdersController,
  mpWebhookController,
  paypalWebhookController,
} from "./checkout.controller";

export async function checkoutRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/checkout", { preHandler: fastify.authenticate }, createCheckoutController);
  fastify.get("/checkout/orders", { preHandler: fastify.authenticate }, listOrdersController);

  fastify.post("/webhooks/mercadopago", mpWebhookController);
  fastify.post("/webhooks/paypal", paypalWebhookController);
}
