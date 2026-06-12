import { FastifyInstance, RouteHandlerMethod } from "fastify";
import { AppError } from "../../lib/errors";
import {
  getMeController,
  updateMeController,
  listUsersController,
  changeRoleController,
  deactivateUserController,
  suspendAccountController,
} from "./users.controller";

async function requireAdmin(request: Parameters<typeof getMeController>[0], reply: Parameters<typeof getMeController>[1]) {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin access required");
  }
}

export async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/users/me", { preHandler: fastify.authenticate }, getMeController);
  fastify.patch("/users/me", { preHandler: fastify.authenticate }, updateMeController);
  fastify.patch("/account/suspend", { preHandler: fastify.authenticate }, suspendAccountController as RouteHandlerMethod);

  fastify.get(
    "/users",
    { preHandler: [fastify.authenticate, requireAdmin] },
    listUsersController,
  );
  fastify.patch(
    "/users/:id/role",
    { preHandler: [fastify.authenticate, requireAdmin] },
    changeRoleController as RouteHandlerMethod,
  );
  fastify.delete(
    "/users/:id",
    { preHandler: [fastify.authenticate, requireAdmin] },
    deactivateUserController as RouteHandlerMethod,
  );
}
