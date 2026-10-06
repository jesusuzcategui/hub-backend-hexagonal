import { FastifyRequest, FastifyReply } from "fastify";
import { checkContentAccess, listUserAccess } from "./content-access.service";

export async function checkAccessController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as { contentType?: string; externalId?: string; documentId?: string };

  // `documentId` is the legacy (Strapi-era) query param name, kept as an alias.
  const externalId = query.externalId ?? query.documentId;

  if (!query.contentType || !externalId) {
    reply.status(400).send({
      error: { code: "MISSING_PARAMS", message: "contentType and externalId are required" },
    });
    return;
  }

  const hasAccess = await checkContentAccess(
    request.server,
    request.user.sub,
    query.contentType,
    externalId,
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
