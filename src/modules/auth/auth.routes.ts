import { FastifyInstance } from "fastify";
import {
  registerController,
  loginController,
  refreshController,
  logoutController,
  meController,
} from "./auth.controller";

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/auth/register", registerController);
  fastify.post("/auth/login", loginController);
  fastify.post("/auth/refresh", refreshController);
  fastify.post("/auth/logout", logoutController);
  fastify.get("/auth/me", { preHandler: fastify.authenticate }, meController);
}
