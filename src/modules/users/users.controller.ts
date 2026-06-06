import { FastifyRequest, FastifyReply } from "fastify";
import { updateProfileSchema, changeRoleSchema } from "./users.schemas";
import {
  getProfile,
  updateProfile,
  listUsers,
  changeUserRole,
  deactivateUser,
} from "./users.service";

export async function getMeController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const profile = await getProfile(request.server, request.user.sub);
  reply.status(200).send({ data: profile });
}

export async function updateMeController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = updateProfileSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  const updated = await updateProfile(request.server, request.user.sub, parsed.data);
  reply.status(200).send({ data: updated });
}

export async function listUsersController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const users = await listUsers(request.server);
  reply.status(200).send({ data: users });
}

export async function changeRoleController(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const parsed = changeRoleSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  const updated = await changeUserRole(
    request.server,
    request.params.id,
    request.user.sub,
    parsed.data,
  );
  reply.status(200).send({ data: updated });
}

export async function deactivateUserController(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  await deactivateUser(request.server, request.params.id, request.user.sub);
  reply.status(204).send();
}
