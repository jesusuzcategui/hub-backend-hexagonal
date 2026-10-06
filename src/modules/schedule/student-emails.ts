import { escapeHtml } from "../payments/payments.service.js";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template.js";
import { formatClassDateTime, normalizeLocale, zoneLabel, type Locale } from "../../lib/locale.js";

// Student-facing transactional emails that depend on the student's language (accounts.locale).
// Pure: they only build {subject, html}; callers send them.

function when(startsAt: Date, locale: Locale): string {
  // Spanish keeps the wording the platform has always used ("(Colombia)"); English states the zone.
  const zone = locale === "es" ? "Colombia" : zoneLabel(locale);
  return `${escapeHtml(formatClassDateTime(startsAt, locale))} (${zone})`;
}

export function buildBookingConfirmedEmail(input: {
  locale: Locale;
  studentName: string;
  productName: string;
  startsAt: Date;
  meetLink: string | null;
}): { subject: string; html: string } {
  const locale = normalizeLocale(input.locale);
  const name = escapeHtml(input.studentName);
  const product = escapeHtml(input.productName);
  const link = input.meetLink ? escapeHtml(input.meetLink) : null;
  const date = when(input.startsAt, locale);

  if (locale === "en") {
    return {
      subject: "✅ Class confirmed",
      html: renderEmailHtml({
        title: "Class confirmed",
        locale,
        bodyHtml: `
          <p>Hi ${name},</p>
          <p>Your <strong>${product}</strong> class is confirmed.</p>
          <p><strong>Date:</strong> ${date}</p>
          ${link ? `<p><strong>Video call link:</strong> <a href="${link}" style="color:${BRAND_COLOR};">${link}</a></p>` : ""}
          <p>If you have any questions, reply to this email.</p>
        `,
      }),
    };
  }
  return {
    subject: "✅ Clase confirmada",
    html: renderEmailHtml({
      title: "Clase confirmada",
      locale,
      bodyHtml: `
        <p>Hola ${name},</p>
        <p>Tu clase de <strong>${product}</strong> está confirmada.</p>
        <p><strong>Fecha:</strong> ${date}</p>
        ${link ? `<p><strong>Link de videollamada:</strong> <a href="${link}" style="color:${BRAND_COLOR};">${link}</a></p>` : ""}
        <p>Si tienes preguntas, responde a este correo.</p>
      `,
    }),
  };
}

export function buildBookingCancelledEmail(input: {
  locale: Locale;
  studentName: string;
  startsAt: Date;
  reason?: string | null;
}): { subject: string; html: string } {
  const locale = normalizeLocale(input.locale);
  const name = escapeHtml(input.studentName);
  const date = when(input.startsAt, locale);
  const reason = input.reason ? escapeHtml(input.reason) : null;

  if (locale === "en") {
    return {
      subject: "❌ Class cancelled",
      html: renderEmailHtml({
        title: "Class cancelled",
        locale,
        bodyHtml: `
          <p>Hi ${name},</p>
          <p>Your class on <strong>${date}</strong> has been cancelled.</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
          <p>Your credit has been refunded. You can book a new class whenever you like.</p>
        `,
      }),
    };
  }
  return {
    subject: "❌ Clase cancelada",
    html: renderEmailHtml({
      title: "Clase cancelada",
      locale,
      bodyHtml: `
        <p>Hola ${name},</p>
        <p>Tu clase del <strong>${date}</strong> ha sido cancelada.</p>
        ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ""}
        <p>Tu crédito ha sido reintegrado. Puedes agendar una nueva clase cuando gustes.</p>
      `,
    }),
  };
}

export function buildWeeklySlotChangeEmail(input: {
  locale: Locale;
  studentName: string;
  startsAt: Date;
}): { subject: string; html: string } {
  const locale = normalizeLocale(input.locale);
  const name = escapeHtml(input.studentName);
  const date = when(input.startsAt, locale);

  if (locale === "en") {
    return {
      subject: "📅 Change to your recurring session schedule",
      html: renderEmailHtml({
        title: "Change to your recurring schedule",
        locale,
        bodyHtml: `
          <p>Hi ${name},</p>
          <p>Your class on <strong>${date}</strong> stays as scheduled and has not been cancelled.</p>
          <p>However, this weekly recurring time will no longer be offered from now on, so you won't be able to book this same time slot automatically in the future.</p>
          <p>If you want to keep taking sessions, you will be able to pick another available time whenever you need.</p>
        `,
      }),
    };
  }
  return {
    subject: "📅 Cambio en el horario recurrente de tus asesorías",
    html: renderEmailHtml({
      title: "Cambio en tu horario recurrente",
      locale,
      bodyHtml: `
        <p>Hola ${name},</p>
        <p>Tu clase agendada para el <strong>${date}</strong> se mantiene sin cambios, no ha sido cancelada.</p>
        <p>Sin embargo, este horario recurrente semanal dejará de ofrecerse a partir de ahora, por lo que no podrás volver a agendar automáticamente en este mismo horario en el futuro.</p>
        <p>Si deseas continuar con tus asesorías, podrás elegir otro horario disponible cuando lo necesites.</p>
      `,
    }),
  };
}
