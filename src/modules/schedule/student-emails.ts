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

// ---- Recurring class series -------------------------------------------------------------------

function dateList(dates: readonly Date[], locale: Locale): string {
  return `<ul style="padding-left:20px;">${dates
    .map((d) => `<li>${escapeHtml(formatClassDateTime(d, locale))}</li>`)
    .join("")}</ul>`;
}

function dashboardLink(url: string, label: string): string {
  const safe = escapeHtml(url);
  return `<p><a href="${safe}" style="color:${BRAND_COLOR};">${escapeHtml(label)}</a></p>`;
}

export function buildSeriesConfirmationEmail(input: {
  locale: Locale;
  studentName: string;
  dates: Date[];
  creditsUsed: number;
  balanceRemaining: number;
  dashboardUrl: string;
  /** Optional extra sentence about the video call links (escaped). */
  meetLinkNote?: string | null;
}): { subject: string; html: string } {
  const locale = normalizeLocale(input.locale);
  const name = escapeHtml(input.studentName);
  const many = input.dates.length !== 1;
  const note = input.meetLinkNote ? `<p>${escapeHtml(input.meetLinkNote)}</p>` : "";

  if (locale === "en") {
    return {
      subject: many ? `✅ Your ${input.dates.length} classes are confirmed` : "✅ Your class is confirmed",
      html: renderEmailHtml({
        title: many ? "Your classes are confirmed" : "Your class is confirmed",
        locale,
        bodyHtml: `
          <p>Hi ${name},</p>
          <p>${many ? "Your recurring classes are booked." : "Your class is booked."} All times are ${escapeHtml(zoneLabel(locale))}.</p>
          ${dateList(input.dates, locale)}
          <p><strong>Credits used:</strong> ${input.creditsUsed}<br><strong>Credits remaining:</strong> ${input.balanceRemaining}</p>
          <p>Each class has its own video call link; you will find it in your dashboard and in the reminders we send before each class.</p>
          ${note}
          ${dashboardLink(input.dashboardUrl, "Go to my dashboard")}
        `,
      }),
    };
  }
  return {
    subject: many ? `✅ Tus ${input.dates.length} clases están confirmadas` : "✅ Tu clase está confirmada",
    html: renderEmailHtml({
      title: many ? "Tus clases están confirmadas" : "Tu clase está confirmada",
      locale,
      bodyHtml: `
        <p>Hola ${name},</p>
        <p>${many ? "Tus clases recurrentes quedaron agendadas." : "Tu clase quedó agendada."} Todos los horarios son en ${escapeHtml(zoneLabel(locale))}.</p>
        ${dateList(input.dates, locale)}
        <p><strong>Créditos usados:</strong> ${input.creditsUsed}<br><strong>Créditos restantes:</strong> ${input.balanceRemaining}</p>
        <p>Cada clase tiene su propio link de videollamada; lo encontrarás en tu panel y en los recordatorios que enviamos antes de cada clase.</p>
        ${note}
        ${dashboardLink(input.dashboardUrl, "Ir a mi panel")}
      `,
    }),
  };
}

export function buildSeriesCancellationEmail(input: {
  locale: Locale;
  studentName: string;
  cancelledDates: Date[];
  /** Occurrences that stay because they start within the 24h cancellation cutoff. */
  keptDates: Date[];
  creditsRefunded: number;
  dashboardUrl: string;
}): { subject: string; html: string } {
  const locale = normalizeLocale(input.locale);
  const name = escapeHtml(input.studentName);
  const hasKept = input.keptDates.length > 0;

  if (locale === "en") {
    return {
      subject: "❌ Class series cancelled",
      html: renderEmailHtml({
        title: "Class series cancelled",
        locale,
        bodyHtml: `
          <p>Hi ${name},</p>
          <p>Your recurring classes have been cancelled. All times are ${escapeHtml(zoneLabel(locale))}.</p>
          <p><strong>Cancelled classes</strong></p>
          ${dateList(input.cancelledDates, locale)}
          ${hasKept ? `<p><strong>These classes will stay because they start in less than 24 hours:</strong></p>${dateList(input.keptDates, locale)}` : ""}
          <p><strong>Credits refunded:</strong> ${input.creditsRefunded}</p>
          ${dashboardLink(input.dashboardUrl, "Go to my dashboard")}
        `,
      }),
    };
  }
  return {
    subject: "❌ Serie de clases cancelada",
    html: renderEmailHtml({
      title: "Serie de clases cancelada",
      locale,
      bodyHtml: `
        <p>Hola ${name},</p>
        <p>Tus clases recurrentes han sido canceladas. Todos los horarios son en ${escapeHtml(zoneLabel(locale))}.</p>
        <p><strong>Clases canceladas</strong></p>
        ${dateList(input.cancelledDates, locale)}
        ${hasKept ? `<p><strong>Clases que se mantienen porque empiezan en menos de 24 horas:</strong></p>${dateList(input.keptDates, locale)}` : ""}
        <p><strong>Créditos reintegrados:</strong> ${input.creditsRefunded}</p>
        ${dashboardLink(input.dashboardUrl, "Ir a mi panel")}
      `,
    }),
  };
}
