import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import {
  addClassNoteAttachment,
  downloadClassNoteAttachment,
  getBookingForAccessCheck,
  getClassNote,
  upsertClassNote,
} from "./class-notes.service";

async function requireBookingAccess(request: FastifyRequest, bookingId: string): Promise<void> {
  if (request.user.role === "admin") return;
  const booking = await getBookingForAccessCheck(request.server, bookingId);
  if (booking.studentId !== request.user.sub) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this class's notes");
  }
}

async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin access required");
  }
}

export async function classNotesRoutes(fastify: FastifyInstance): Promise<void> {
  // Admin: write the Markdown note for a class.
  fastify.put(
    "/admin/bookings/:id/notes",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { content } = (req.body ?? {}) as { content?: string };
      if (typeof content !== "string") {
        throw new AppError(400, "MISSING_FIELDS", "content (string) is required");
      }
      const data = await upsertClassNote(fastify, id, req.user.sub as string, content);
      reply.send({ data });
    },
  );

  // Admin: attach an image/video to a class's note.
  fastify.post(
    "/admin/bookings/:id/notes/attachments",
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!req.isMultipart()) {
        throw new AppError(400, "MISSING_FILE", "multipart/form-data with a file is required");
      }
      const file = await req.file();
      if (!file) throw new AppError(400, "MISSING_FILE", "Attachment file is required");
      const data = await addClassNoteAttachment(fastify, id, req.user.sub as string, {
        filename: file.filename,
        buffer: await file.toBuffer(),
        mimetype: file.mimetype,
      });
      reply.status(201).send({ data });
    },
  );

  // Read the note for a class — admin sees any, student sees only their own booking.
  fastify.get(
    "/bookings/:id/notes",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await requireBookingAccess(req, id);
      reply.send({ data: await getClassNote(fastify, id) });
    },
  );

  // Stream a note's attachment — same access rule as reading the note.
  fastify.get(
    "/bookings/:id/notes/attachment",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { path: remotePath } = req.query as { path?: string };
      if (!remotePath) throw new AppError(400, "MISSING_FIELDS", "path query param is required");

      await requireBookingAccess(req, id);
      const { buffer, attachment } = await downloadClassNoteAttachment(fastify, id, remotePath);
      // contentType was already validated against ALLOWED_MIME at upload time, but this
      // is the response an attacker could get a victim to click — nosniff blocks the
      // browser from guessing a different (script-executing) type for the bytes.
      reply
        .header("Content-Type", attachment.contentType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `inline; filename="${attachment.filename}"`)
        .send(buffer);
    },
  );
}
