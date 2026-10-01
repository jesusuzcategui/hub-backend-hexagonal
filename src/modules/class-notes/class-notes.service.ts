import path from "node:path";
import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { bookings, classNotes } from "../../db/schema";
import { AppError } from "../../lib/errors";

type Attachment = { filename: string; path: string; contentType: string };

// Images/video only — attachments are served back with `inline` disposition, so anything
// HTML/SVG-capable (text/html, image/svg+xml, ...) would be stored XSS. No document types
// either; this field is for class media, not files.
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
]);

function webdavDir(bookingId: string): string {
  return `/hub-payments/class-notes/${bookingId}`;
}

export async function getBookingForAccessCheck(fastify: FastifyInstance, bookingId: string) {
  const booking = await fastify.drizzle.query.bookings.findFirst({
    where: eq(bookings.id, bookingId),
    columns: { id: true, studentId: true },
  });
  if (!booking) throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  return booking;
}

export async function getClassNote(fastify: FastifyInstance, bookingId: string) {
  return fastify.drizzle.query.classNotes.findFirst({ where: eq(classNotes.bookingId, bookingId) });
}

export async function upsertClassNote(
  fastify: FastifyInstance,
  bookingId: string,
  authorId: string,
  content: string,
) {
  await getBookingForAccessCheck(fastify, bookingId);

  const [note] = await fastify.drizzle
    .insert(classNotes)
    .values({ bookingId, authorId, content })
    .onConflictDoUpdate({
      target: classNotes.bookingId,
      set: { content, authorId, updatedAt: new Date() },
    })
    .returning();

  return note;
}

export async function addClassNoteAttachment(
  fastify: FastifyInstance,
  bookingId: string,
  authorId: string,
  file: { filename: string; buffer: Buffer; mimetype: string },
) {
  await getBookingForAccessCheck(fastify, bookingId);

  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new AppError(400, "UNSUPPORTED_MEDIA_TYPE", "Only images (png/jpeg/webp/gif) or video (mp4/webm) are allowed");
  }

  const safeName = path.basename(file.filename).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") {
    throw new AppError(400, "INVALID_FILENAME", "Invalid attachment file name");
  }

  const dir = webdavDir(bookingId);
  if (!(await fastify.webdav.exists(dir))) {
    await fastify.webdav.createDirectory(dir, { recursive: true });
  }
  const remotePath = `${dir}/${Date.now()}-${safeName}`;
  await fastify.webdav.putFileContents(remotePath, file.buffer, { overwrite: true });

  const attachment: Attachment = { filename: safeName, path: remotePath, contentType: file.mimetype };

  const existing = await getClassNote(fastify, bookingId);
  const attachments: Attachment[] = existing ? [...(existing.attachments as Attachment[]), attachment] : [attachment];

  const [note] = await fastify.drizzle
    .insert(classNotes)
    .values({ bookingId, authorId, content: "", attachments })
    .onConflictDoUpdate({
      target: classNotes.bookingId,
      set: { attachments, updatedAt: new Date() },
    })
    .returning();

  return note;
}

export async function downloadClassNoteAttachment(
  fastify: FastifyInstance,
  bookingId: string,
  remotePath: string,
) {
  const note = await getClassNote(fastify, bookingId);
  const attachment = (note?.attachments as Attachment[] | undefined)?.find((a) => a.path === remotePath);
  if (!attachment) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");

  const buffer = (await fastify.webdav.getFileContents(remotePath)) as Buffer;
  return { buffer, attachment };
}
