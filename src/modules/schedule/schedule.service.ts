import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { accounts } from "../../db/schema/users.js";
import { products } from "../../db/schema/ecommerce.js";
import { availabilities, bookings, classCredits, weeklySlots } from "../../db/schema/scheduling.js";
import "../../plugins/caldav.js";

function icalDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icalEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function buildIcal({
  uid,
  startsAt,
  endsAt,
  summary,
  description,
  location,
  attendeeEmail,
  method,
}: {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string;
  location?: string;
  attendeeEmail?: string;
  method?: "REQUEST";
}): string {
  const now = icalDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method ? [`METHOD:${method}`] : []),
    "PRODID:-//Hub Vanjex//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}@vanjex.dev`,
    `DTSTAMP:${now}`,
    `DTSTART:${icalDate(startsAt)}`,
    `DTEND:${icalDate(endsAt)}`,
    `SUMMARY:${icalEscape(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icalEscape(description)}`);
  if (location) lines.push(`LOCATION:${icalEscape(location)}`);
  lines.push(`ORGANIZER;CN=${icalEscape(env.smtp.fromName)}:mailto:${env.smtp.from}`);
  if (attendeeEmail) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function pad2(n: number) { return String(n).padStart(2, "0"); }

// Split a time range into 1-hour chunks. Returns array of { chunkStart, chunkEnd } in HH:MM.
function hourChunks(startTime: string, endTime: string): Array<{ chunkStart: string; chunkEnd: string }> {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const chunks: Array<{ chunkStart: string; chunkEnd: string }> = [];
  for (let m = startMin; m + 60 <= endMin; m += 60) {
    chunks.push({
      chunkStart: `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`,
      chunkEnd: `${pad2(Math.floor((m + 60) / 60))}:${pad2((m + 60) % 60)}`,
    });
  }
  // If range < 1h or not divisible, treat the whole range as one slot
  if (chunks.length === 0 && endMin > startMin) {
    chunks.push({ chunkStart: startTime, chunkEnd: endTime });
  }
  return chunks;
}

// Generate upcoming 1-hour slot instances for a weekly slot (Colombia time = UTC-5)
function upcomingOccurrences(dayOfWeek: number, startTime: string, endTime: string, weeks = 6) {
  const now = new Date();
  const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = bogotaFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const nowBogotaH = parseInt(get("hour") === "24" ? "0" : get("hour"));
  const nowBogotaM = parseInt(get("minute"));
  const todayBogota = new Date(parseInt(get("year")), parseInt(get("month")) - 1, parseInt(get("day")));
  const todayDow = todayBogota.getDay();

  const chunks = hourChunks(startTime, endTime);
  const results: Array<{ slotDate: string; chunkHHMM: string; startsAt: Date; endsAt: Date }> = [];

  for (let w = 0; w < weeks; w++) {
    let daysUntil = (dayOfWeek - todayDow + 7) % 7 + w * 7;
    if (daysUntil === 0 && w === 0) daysUntil = 0; // same day handled per-chunk below

    const target = new Date(todayBogota);
    target.setDate(todayBogota.getDate() + daysUntil);
    const y = target.getFullYear();
    const mo = pad2(target.getMonth() + 1);
    const d = pad2(target.getDate());
    const slotDate = `${y}${mo}${d}`;

    for (const { chunkStart, chunkEnd } of chunks) {
      const [ch, cm] = chunkStart.split(":").map(Number);
      // Skip if same day and this chunk already passed
      if (daysUntil === 0 && w === 0 && (ch < nowBogotaH || (ch === nowBogotaH && cm <= nowBogotaM))) {
        continue;
      }
      const startsAt = new Date(`${y}-${mo}-${d}T${chunkStart}:00-05:00`);
      const endsAt = new Date(`${y}-${mo}-${d}T${chunkEnd}:00-05:00`);
      results.push({ slotDate, chunkHHMM: chunkStart.replace(":", ""), startsAt, endsAt });
    }
  }

  return results;
}

export async function getAvailableSlots(fastify: FastifyInstance) {
  const slots = await fastify.drizzle
    .select({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
    })
    .from(weeklySlots)
    .where(eq(weeklySlots.isActive, true));

  if (slots.length === 0) return [];

  // Find all future bookings on weekly slots (confirmed/pending) to know which are taken
  const takenBookings = await fastify.drizzle
    .select({
      weeklySlotId: bookings.weeklySlotId,
      startsAt: bookings.startsAt,
    })
    .from(bookings)
    .where(
      and(
        gt(bookings.startsAt, new Date()),
        sql`${bookings.status} IN ('confirmed', 'pending')`,
        isNull(bookings.availabilityId),
      ),
    );

  // takenKey format: weeklySlotId_YYYYMMDD_HHMM (startsAt in Bogotá time)
  const takenKeys = new Set(
    takenBookings.map((b) => {
      // Convert UTC startsAt → Bogotá date+time for key
      const iso = b.startsAt.toISOString(); // e.g. 2026-06-16T15:00:00.000Z = 10:00 COT
      const bogota = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(iso));
      const gp = (type: string) => bogota.find((p) => p.type === type)?.value ?? "0";
      const dateKey = `${gp("year")}${gp("month")}${gp("day")}`;
      const h = gp("hour") === "24" ? "00" : gp("hour");
      const timeKey = `${h}${gp("minute")}`;
      return `${b.weeklySlotId}_${dateKey}_${timeKey}`;
    }),
  );

  const available: Array<{ id: string; startsAt: string; endsAt: string }> = [];

  for (const slot of slots) {
    const occurrences = upcomingOccurrences(slot.dayOfWeek, slot.startTime, slot.endTime, 6);
    for (const occ of occurrences) {
      const key = `${slot.id}_${occ.slotDate}_${occ.chunkHHMM}`;
      if (!takenKeys.has(key)) {
        available.push({
          id: key,
          startsAt: occ.startsAt.toISOString(),
          endsAt: occ.endsAt.toISOString(),
        });
      }
    }
  }

  return available.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function getStudentCredits(fastify: FastifyInstance, userId: string) {
  const now = new Date();
  const rows = await fastify.drizzle
    .select({
      creditId: classCredits.id,
      productId: classCredits.productId,
      productName: products.name,
      totalCredits: classCredits.totalCredits,
      usedCredits: classCredits.usedCredits,
      expiresAt: classCredits.expiresAt,
    })
    .from(classCredits)
    .innerJoin(products, eq(classCredits.productId, products.id))
    .where(
      and(
        eq(classCredits.userId, userId),
        sql`${classCredits.usedCredits} < ${classCredits.totalCredits}`,
        or(isNull(classCredits.expiresAt), gt(classCredits.expiresAt, now)),
      ),
    );

  return rows.map((r) => ({
    creditId: r.creditId,
    productId: r.productId,
    productName: r.productName,
    remaining: r.totalCredits - r.usedCredits,
    expiresAt: r.expiresAt,
  }));
}

export async function createStudentBooking(
  fastify: FastifyInstance,
  params: {
    studentId: string;
    slotId: string; // composite: weeklySlotId_YYYYMMDD_HHMM OR legacy availabilityId (uuid)
    creditId: string;
    notes?: string;
  },
) {
  const { studentId, slotId, creditId, notes } = params;

  const student = await fastify.drizzle
    .select({ id: accounts.id, email: accounts.email, displayName: accounts.displayName })
    .from(accounts)
    .where(eq(accounts.id, studentId))
    .limit(1);
  if (!student[0]) throw new Error("Student not found");

  // ID formats: "uuid" (legacy availability) | "uuid_YYYYMMDD_HHMM" (weekly slot chunk)
  const idParts = slotId.split("_");
  const isWeeklySlot = idParts.length >= 3;
  let weeklySlotId: string | null = null;
  let availabilityId: string | null = null;
  let startsAt: Date;
  let endsAt: Date;

  if (isWeeklySlot) {
    weeklySlotId = idParts[0]; // UUID (no underscores)
    const datePart = idParts[1]; // YYYYMMDD
    const timePart = idParts[2]; // HHMM

    const slot = await fastify.drizzle
      .select({
        id: weeklySlots.id,
        dayOfWeek: weeklySlots.dayOfWeek,
        startTime: weeklySlots.startTime,
        endTime: weeklySlots.endTime,
        isActive: weeklySlots.isActive,
      })
      .from(weeklySlots)
      .where(eq(weeklySlots.id, weeklySlotId))
      .limit(1);

    if (!slot[0]) throw new Error("Weekly slot not found");
    if (!slot[0].isActive) throw new Error("Weekly slot is not active");

    const y = datePart.substring(0, 4);
    const mo = datePart.substring(4, 6);
    const d = datePart.substring(6, 8);
    const hh = timePart.substring(0, 2);
    const mm = timePart.substring(2, 4);
    const chunkStartHHMM = `${hh}:${mm}`;

    // Validate day-of-week matches the slot definition
    const bogotaDay = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota", weekday: "short",
    }).format(new Date(`${y}-${mo}-${d}T12:00:00-05:00`));
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const suppliedDow = dowMap[bogotaDay] ?? -1;
    if (suppliedDow !== slot[0].dayOfWeek) {
      throw new Error("Invalid slot: date does not match slot day-of-week");
    }

    // Validate the chunk start time is a legitimate hour-chunk of this slot's range
    const validChunks = hourChunks(slot[0].startTime, slot[0].endTime).map((c) => c.chunkStart);
    if (!validChunks.includes(chunkStartHHMM)) {
      throw new Error("Invalid slot: time is not a valid hour chunk of this slot");
    }

    const hEnd = pad2(parseInt(hh) + 1); // always 1-hour slot
    startsAt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:00-05:00`);
    endsAt = new Date(`${y}-${mo}-${d}T${hEnd}:${mm}:00-05:00`);

    if (startsAt <= new Date()) throw new Error("Slot is in the past");
  } else {
    availabilityId = slotId;
    const [avail] = await fastify.drizzle
      .select()
      .from(availabilities)
      .where(eq(availabilities.id, slotId))
      .limit(1);
    if (!avail) throw new Error("Slot not found");
    if (avail.isBooked) throw new Error("Slot already booked");
    startsAt = avail.startsAt;
    endsAt = avail.endsAt;
  }

  let bookingId: string;
  let verifiedProductId: string;
  let meetLink: string | null = null;

  await fastify.drizzle.transaction(async (tx) => {
    if (weeklySlotId) {
      // Check for race condition: someone else booking same weekly slot + date
      const [existing] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.weeklySlotId, weeklySlotId),
            eq(bookings.startsAt, startsAt),
            sql`${bookings.status} IN ('confirmed', 'pending')`,
          ),
        )
        .for("update")
        .limit(1);
      if (existing) throw new Error("Slot already booked");
    } else if (availabilityId) {
      const [slot] = await tx
        .select({ isBooked: availabilities.isBooked })
        .from(availabilities)
        .where(eq(availabilities.id, availabilityId))
        .for("update");
      if (!slot || slot.isBooked) throw new Error("Slot already booked");
      await tx
        .update(availabilities)
        .set({ isBooked: true })
        .where(eq(availabilities.id, availabilityId));
    }

    const [credit] = await tx
      .select()
      .from(classCredits)
      .where(and(eq(classCredits.id, creditId), eq(classCredits.userId, studentId)))
      .for("update");

    if (!credit) throw new Error("Credit not found");
    if (credit.usedCredits >= credit.totalCredits) throw new Error("No credits remaining");
    verifiedProductId = credit.productId;

    await tx
      .update(classCredits)
      .set({ usedCredits: sql`${classCredits.usedCredits} + 1` })
      .where(eq(classCredits.id, creditId));

    const [inserted] = await tx
      .insert(bookings)
      .values({
        studentId,
        creditId,
        availabilityId,
        weeklySlotId,
        productId: credit.productId,
        status: "confirmed",
        startsAt,
        endsAt,
        studentNotes: notes ?? null,
      })
      .returning({ id: bookings.id });

    bookingId = inserted.id;

    const jitsiRoom = `clase-${bookingId!.replace(/-/g, "")}`;
    const jitsiLink = `${env.jitsi.baseUrl}/${jitsiRoom}`;
    await tx
      .update(bookings)
      .set({ meetLink: jitsiLink })
      .where(eq(bookings.id, bookingId!));
    meetLink = jitsiLink;
  });

  // Load product name using the credit's verified productId (not client-supplied)
  const [product] = await fastify.drizzle
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, verifiedProductId!))
    .limit(1);

  // Create CalDAV event for admin calendar visibility
  const icalForCalDAV = buildIcal({
    uid: bookingId!,
    startsAt: startsAt!,
    endsAt: endsAt!,
    summary: `Clase — ${product?.name ?? "English"} · ${student[0].displayName}`,
    description: meetLink ?? undefined,
    location: meetLink ?? undefined,
    attendeeEmail: student[0].email,
  });
  try {
    await fastify.caldav.createEvent(bookingId!, icalForCalDAV);
    await fastify.drizzle
      .update(bookings)
      .set({ gcalEventId: bookingId! })
      .where(eq(bookings.id, bookingId!));
  } catch (err) {
    fastify.log.error({ err }, "Failed to create CalDAV event");
  }

  // Send booking confirmation email with calendar invite attachment
  try {
    const bogotaDate = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "full",
      timeStyle: "short",
    }).format(startsAt!);

    const icalInvite = buildIcal({
      uid: bookingId!,
      startsAt: startsAt!,
      endsAt: endsAt!,
      summary: `Clase — ${product?.name ?? "English"}`,
      description: meetLink ?? undefined,
      location: meetLink ?? undefined,
      attendeeEmail: student[0].email,
      method: "REQUEST",
    });

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: student[0].email,
      subject: "✅ Clase confirmada",
      html: `
        <p>Hola ${student[0].displayName},</p>
        <p>Tu clase de <strong>${product?.name ?? "inglés"}</strong> está confirmada.</p>
        <p><strong>Fecha:</strong> ${bogotaDate} (Colombia)</p>
        ${meetLink ? `<p><strong>Link de videollamada:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ""}
        <p>Si tienes preguntas, responde a este correo.</p>
        <p>— ${env.smtp.fromName}</p>
      `,
      attachments: [
        {
          filename: "clase.ics",
          content: icalInvite,
          contentType: "text/calendar; method=REQUEST; charset=UTF-8",
        },
      ],
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send booking confirmation email");
  }

  return { bookingId: bookingId!, meetLink, startsAt: startsAt! };
}

export async function listStudentBookings(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      meetLink: bookings.meetLink,
      cancelledAt: bookings.cancelledAt,
      studentNotes: bookings.studentNotes,
      productName: products.name,
      gcalEventId: bookings.gcalEventId,
    })
    .from(bookings)
    .innerJoin(products, eq(bookings.productId, products.id))
    .where(eq(bookings.studentId, userId))
    .orderBy(bookings.startsAt);
}

export async function cancelStudentBooking(
  fastify: FastifyInstance,
  bookingId: string,
  userId: string,
) {
  const [booking] = await fastify.drizzle
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.studentId, userId)))
    .limit(1);

  if (!booking) throw new Error("Booking not found");
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("Booking cannot be cancelled");
  }

  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (booking.startsAt <= cutoff) {
    throw new Error("Cannot cancel within 24 hours of class");
  }

  await fastify.drizzle.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "Student cancelled" })
      .where(eq(bookings.id, bookingId));

    if (booking.availabilityId) {
      await tx
        .update(availabilities)
        .set({ isBooked: false })
        .where(eq(availabilities.id, booking.availabilityId));
    }

    await tx
      .update(classCredits)
      .set({ usedCredits: sql`GREATEST(${classCredits.usedCredits} - 1, 0)` })
      .where(eq(classCredits.id, booking.creditId));
  });

  if (booking.gcalEventId) {
    try {
      await fastify.caldav.deleteEvent(booking.gcalEventId);
    } catch (err) {
      fastify.log.error({ err }, "Failed to delete CalDAV event");
    }
  }
}
