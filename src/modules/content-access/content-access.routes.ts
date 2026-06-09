import { FastifyInstance } from "fastify";
import { checkAccessController, listAccessController } from "./content-access.controller";

export async function contentAccessRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/access/check", { preHandler: fastify.authenticate }, checkAccessController);
  fastify.get("/access/my", { preHandler: fastify.authenticate }, listAccessController);
}
