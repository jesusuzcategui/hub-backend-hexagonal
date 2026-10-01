import { FastifyInstance } from "fastify";
import {
  checkoutController,
  epaycoWebhookController,
  paypalWebhookController,
  publicOrderStatusController,
  paypalCaptureController,
  myOrdersController,
} from "./payments.controller";

// Public, no-auth: checkout mirrors the cart module (buyers have no account yet), and
// webhooks authenticate via provider signature (epayco) / signed callback (paypal), not
// session auth. Admin-facing order listing + manual-transfer validation live in
// admin.routes.ts / admin.service.ts, per the existing pattern for admin-only concerns.
export async function paymentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/checkout", checkoutController);
  fastify.post("/webhooks/epayco", epaycoWebhookController);
  fastify.post("/webhooks/paypal", paypalWebhookController);
  fastify.get("/order/:id", publicOrderStatusController);
  fastify.post("/paypal/capture/:paypalOrderId", paypalCaptureController);
  fastify.get("/orders/my", { preHandler: [fastify.authenticate] }, myOrdersController);
}
