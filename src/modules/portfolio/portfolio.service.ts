import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { bookings, mentoringRequests, weeklySlots } from "../../db/schema/scheduling.js";
import type { BookSlotBody, SubmitReviewBody } from "./portfolio.schemas.js";
import "../../plugins/caldav.js";
import "../../plugins/mailer.js";

// ── iCal helpers (duplicated from schedule.service — these are pure utilities) ──

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

function buildIcal(opts: {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string;
  attendeeEmail?: string;
  method?: "REQUEST";
}): string {
  const now = icalDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(opts.method ? [`METHOD:${opts.method}`] : []),
    "PRODID:-//Hub Vanjex//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${opts.uid}@vanjex.dev`,
    `DTSTAMP:${now}`,
    `DTSTART:${icalDate(opts.startsAt)}`,
    `DTEND:${icalDate(opts.endsAt)}`,
    `SUMMARY:${icalEscape(opts.summary)}`,
  ];
  if (opts.description) lines.push(`DESCRIPTION:${icalEscape(opts.description)}`);
  lines.push(`ORGANIZER;CN=${icalEscape(env.smtp.fromName)}:mailto:${env.smtp.from}`);
  if (opts.attendeeEmail)
    lines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${opts.attendeeEmail}`,
    );
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// ── Slot generation helpers ──

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function hourChunks(
  startTime: string,
  endTime: string,
): Array<{ chunkStart: string; chunkEnd: string }> {
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
  if (chunks.length === 0 && endMin > startMin) {
    chunks.push({ chunkStart: startTime, chunkEnd: endTime });
  }
  return chunks;
}

function upcomingOccurrences(dayOfWeek: number, startTime: string, endTime: string, weeks = 6) {
  const now = new Date();
  const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = bogotaFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const nowBogotaH = parseInt(get("hour") === "24" ? "0" : get("hour"));
  const nowBogotaM = parseInt(get("minute"));
  const todayBogota = new Date(parseInt(get("year")), parseInt(get("month")) - 1, parseInt(get("day")));
  const todayDow = todayBogota.getDay();

  const slots = hourChunks(startTime, endTime);
  const results: Array<{ slotDate: string; chunkHHMM: string; startsAt: Date; endsAt: Date }> = [];

  for (let w = 0; w < weeks; w++) {
    let daysUntil = (dayOfWeek - todayDow + 7) % 7 + w * 7;
    if (daysUntil === 0 && w === 0) daysUntil = 0;

    const target = new Date(todayBogota);
    target.setDate(todayBogota.getDate() + daysUntil);
    const y = target.getFullYear();
    const mo = pad2(target.getMonth() + 1);
    const d = pad2(target.getDate());
    const slotDate = `${y}${mo}${d}`;

    for (const { chunkStart, chunkEnd } of slots) {
      const [ch, cm] = chunkStart.split(":").map(Number);
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

// ── HTML escape ──

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Public service functions ──

export async function getPublicSlots(fastify: FastifyInstance) {
  const teacherId = env.mentoring.teacherId;

  const slots = await fastify.drizzle
    .select({
      id: weeklySlots.id,
      dayOfWeek: weeklySlots.dayOfWeek,
      startTime: weeklySlots.startTime,
      endTime: weeklySlots.endTime,
    })
    .from(weeklySlots)
    .where(and(eq(weeklySlots.teacherId, teacherId), eq(weeklySlots.isActive, true)));

  if (slots.length === 0) return [];

  // Taken from existing ClickTalk bookings on these slots
  const takenBookings = await fastify.drizzle
    .select({ weeklySlotId: bookings.weeklySlotId, startsAt: bookings.startsAt })
    .from(bookings)
    .where(
      and(
        gt(bookings.startsAt, new Date()),
        sql`${bookings.status} IN ('confirmed', 'pending')`,
        isNull(bookings.availabilityId),
      ),
    );

  // Taken from existing mentoring requests
  const takenMentoring = await fastify.drizzle
    .select({ slotId: mentoringRequests.slotId })
    .from(mentoringRequests)
    .where(
      and(
        gt(mentoringRequests.startsAt, new Date()),
        sql`${mentoringRequests.status} IN ('pending', 'confirmed')`,
      ),
    );

  const bogotaFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const takenKeys = new Set<string>();

  for (const b of takenBookings) {
    if (!b.weeklySlotId) continue;
    const parts = bogotaFmt.formatToParts(b.startsAt);
    const gp = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
    const dateKey = `${gp("year")}${gp("month")}${gp("day")}`;
    const h = gp("hour") === "24" ? "00" : gp("hour");
    takenKeys.add(`${b.weeklySlotId}_${dateKey}_${h}${gp("minute")}`);
  }

  for (const m of takenMentoring) {
    takenKeys.add(m.slotId);
  }

  const available: Array<{ id: string; startsAt: string; endsAt: string }> = [];

  for (const slot of slots) {
    const occurrences = upcomingOccurrences(slot.dayOfWeek, slot.startTime, slot.endTime, 6);
    for (const occ of occurrences) {
      const key = `${slot.id}_${occ.slotDate}_${occ.chunkHHMM}`;
      if (!takenKeys.has(key)) {
        available.push({ id: key, startsAt: occ.startsAt.toISOString(), endsAt: occ.endsAt.toISOString() });
      }
    }
  }

  return available.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const TYPE_LABELS: Record<string, string> = {
  wordpress: "WordPress",
  shopify: "Shopify",
  custom: "Sistema Personalizado",
  quote: "Cotización",
};

const TYPE_LABELS_EN: Record<string, string> = {
  wordpress: "WordPress",
  shopify: "Shopify",
  custom: "Custom System",
  quote: "Quote",
};

export async function createMentoringRequest(fastify: FastifyInstance, body: BookSlotBody) {
  const { slotId, name, email, whatsapp, type, message, locale = "es" } = body;

  const idParts = slotId.split("_");
  if (idParts.length < 3) throw new Error("Invalid slot ID format");

  const weeklySlotId = idParts[0];
  const datePart = idParts[1];
  const timePart = idParts[2];

  const [slot] = await fastify.drizzle
    .select({ id: weeklySlots.id, startTime: weeklySlots.startTime, endTime: weeklySlots.endTime })
    .from(weeklySlots)
    .where(and(eq(weeklySlots.id, weeklySlotId), eq(weeklySlots.isActive, true)))
    .limit(1);

  if (!slot) throw new Error("Slot not found");

  const y = datePart.substring(0, 4);
  const mo = datePart.substring(4, 6);
  const d = datePart.substring(6, 8);
  const hh = timePart.substring(0, 2);
  const mm = timePart.substring(2, 4);

  const startsAt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:00-05:00`);
  const hEnd = pad2(parseInt(hh) + 1);
  const endsAt = new Date(`${y}-${mo}-${d}T${hEnd}:${mm}:00-05:00`);

  if (startsAt <= new Date()) throw new Error("Slot is in the past");

  let requestId: string;

  await fastify.drizzle.transaction(async (tx) => {
    // Race check: ClickTalk booking on same slot + time
    const [existingBooking] = await tx
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
    if (existingBooking) throw new Error("Slot already booked");

    // Race check: another mentoring request on same slot
    const [existingRequest] = await tx
      .select({ id: mentoringRequests.id })
      .from(mentoringRequests)
      .where(
        and(
          eq(mentoringRequests.slotId, slotId),
          sql`${mentoringRequests.status} IN ('pending', 'confirmed')`,
        ),
      )
      .for("update")
      .limit(1);
    if (existingRequest) throw new Error("Slot already booked");

    const [inserted] = await tx
      .insert(mentoringRequests)
      .values({
        name,
        email,
        whatsapp: whatsapp ?? null,
        type,
        message: message ?? null,
        slotId,
        startsAt,
        endsAt,
      })
      .returning({ id: mentoringRequests.id });

    requestId = inserted.id;
  });

  const jitsiUrl = `https://talk.jesusuzcategui.com/${requestId!}`;

  const isEs = locale === "es";
  const typeLbl = TYPE_LABELS[type] ?? type;
  const typeLblEn = TYPE_LABELS_EN[type] ?? type;

  const bogotaDateEs = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "full",
    timeStyle: "short",
  }).format(startsAt);

  const bogotaDateEn = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    dateStyle: "full",
    timeStyle: "short",
  }).format(startsAt);

  // CalDAV event in Nextcloud
  const ical = buildIcal({
    uid: requestId!,
    startsAt,
    endsAt,
    summary: `Asesoría — ${typeLbl} · ${name}`,
    description: [message, `Enlace Jitsi: ${jitsiUrl}`].filter(Boolean).join("\n\n"),
    attendeeEmail: email,
  });
  try {
    await fastify.caldav.createEvent(requestId!, ical);
    await fastify.drizzle
      .update(mentoringRequests)
      .set({ gcalEventId: requestId! })
      .where(eq(mentoringRequests.id, requestId!));
  } catch (err) {
    fastify.log.error({ err }, "Failed to create CalDAV event for mentoring request");
  }

  // Admin notification
  try {
    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: "hola@jesusuzcategui.com",
      replyTo: `"${name}" <${email}>`,
      subject: `[Portafolio] Nueva asesoría — ${typeLbl} · ${name}`,
      html: `
<h2 style="margin:0 0 16px">Nueva solicitud de asesoría</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
  <tr><td style="padding:5px 16px 5px 0;color:#888">Nombre</td><td>${esc(name)}</td></tr>
  <tr><td style="padding:5px 16px 5px 0;color:#888">Email</td><td><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
  ${whatsapp ? `<tr><td style="padding:5px 16px 5px 0;color:#888">WhatsApp</td><td>${esc(whatsapp)}</td></tr>` : ""}
  <tr><td style="padding:5px 16px 5px 0;color:#888">Tipo</td><td>${esc(typeLbl)}</td></tr>
  <tr><td style="padding:5px 16px 5px 0;color:#888">Fecha</td><td>${esc(bogotaDateEs)}</td></tr>
  <tr><td style="padding:5px 16px 5px 0;color:#888">Idioma</td><td>${isEs ? "Español" : "English"}</td></tr>
  <tr><td style="padding:5px 16px 5px 0;color:#888">Enlace Jitsi</td><td><a href="${esc(jitsiUrl)}">${esc(jitsiUrl)}</a></td></tr>
</table>
${message ? `<h3 style="margin:20px 0 8px">Mensaje</h3><p style="white-space:pre-wrap;font-size:14px">${esc(message)}</p>` : ""}
      `.trim(),
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send admin mentoring notification");
  }

  // Client confirmation
  try {
    const icalInvite = buildIcal({
      uid: requestId!,
      startsAt,
      endsAt,
      summary: `Asesoría ${typeLbl} — Jesus Uzcategui`,
      description: `Enlace Jitsi: ${jitsiUrl}`,
      attendeeEmail: email,
      method: "REQUEST",
    });

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: email,
      subject: isEs ? "✅ Solicitud de asesoría recibida" : "✅ Mentoring request received",
      html: isEs ? `
<p>Hola ${esc(name)},</p>
<p>Recibí tu solicitud de asesoría de <strong>${esc(typeLbl)}</strong>.</p>
<p><strong>Fecha tentativa:</strong> ${esc(bogotaDateEs)} (hora Colombia)</p>
<p><strong>Enlace Jitsi para la sesión:</strong><br>
<a href="${esc(jitsiUrl)}" style="display:inline-block;margin-top:6px;padding:10px 18px;background:#0d9488;color:#fff;text-decoration:none;border-radius:4px;font-weight:600">${esc(jitsiUrl)}</a></p>
<p style="font-size:12px;color:#888">El enlace estará activo el día de la sesión. Te confirmaré la cita por WhatsApp.</p>
<p>— Jesus Uzcategui</p>
      `.trim() : `
<p>Hi ${esc(name)},</p>
<p>I received your mentoring request for <strong>${esc(typeLblEn)}</strong>.</p>
<p><strong>Tentative date:</strong> ${esc(bogotaDateEn)} (Colombia Time)</p>
<p><strong>Your Jitsi link for the session:</strong><br>
<a href="${esc(jitsiUrl)}" style="display:inline-block;margin-top:6px;padding:10px 18px;background:#0d9488;color:#fff;text-decoration:none;border-radius:4px;font-weight:600">${esc(jitsiUrl)}</a></p>
<p style="font-size:12px;color:#888">The link will be active on the day of the session. I'll confirm the appointment via WhatsApp.</p>
<p>— Jesus Uzcategui</p>
      `.trim(),
      attachments: [
        {
          filename: "asesoria.ics",
          content: icalInvite,
          contentType: "text/calendar; method=REQUEST; charset=UTF-8",
        },
      ],
    });
  } catch (err) {
    fastify.log.error({ err }, "Failed to send client mentoring confirmation");
  }

  return { id: requestId!, startsAt: startsAt.toISOString() };
}

export async function submitReview(body: SubmitReviewBody): Promise<void> {
  const res = await fetch(`${env.strapi.url}/api/reviews?status=draft`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.strapi.token}`,
    },
    body: JSON.stringify({
      data: {
        author_name: body.author_name,
        rating: body.rating,
        message: body.message,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Strapi error: ${res.status}`);
  }
}
