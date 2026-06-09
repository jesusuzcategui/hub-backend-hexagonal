import { FastifyRequest, FastifyReply } from "fastify";
import { checkContentAccess, listUserAccess } from "./content-access.service";

export async function checkAccessController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as { contentType?: string; documentId?: string };

  if (!query.contentType || !query.documentId) {
    reply.status(400).send({
      error: { code: "MISSING_PARAMS", message: "contentType and documentId are required" },
    });
    return;
  }

  const hasAccess = await checkContentAccess(
    request.server,
    request.user.sub,
    query.contentType,
    query.documentId,
  );

  reply.send({ data: { hasAccess } });
}

export async function listAccessController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listUserAccess(request.server, request.user.sub);
  reply.send({ data });
}
