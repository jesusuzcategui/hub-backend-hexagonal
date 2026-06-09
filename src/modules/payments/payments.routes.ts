import { FastifyInstance } from "fastify";
import { listPaymentsController } from "./payments.controller";

export async function paymentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/payments", { preHandler: fastify.authenticate }, listPaymentsController);
}
