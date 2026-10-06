import { escapeHtml } from "../payments/payments.service.js";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template.js";
import {
  formatClassDateTime,
  formatClassDateTimeShort,
  normalizeLocale,
  zoneLabel,
  type Locale,
} from "../../lib/locale.js";

export type ReminderKind = "24h" | "1h";

export interface ReminderCandidate {
  id: string;
  status: string;
  startsAt: Date;
  createdAt: Date;
  reminder24hSentAt: Date | null;
  reminder1hSentAt: Date | null;
}

export interface DueReminder {
  bookingId: string;
  kind: ReminderKind;
}

const HOUR_MS = 3_600_000;

/**
 * Catch-up grace: a reminder is still sent up to this long AFTER its nominal time, so a short
 * outage or restart does not lose it. Past that the notice would be stale ("in 24 hours" sent
 * 6 hours late), so it is dropped. The 1h reminder is additionally capped by the class start.
 */
export const REMINDER_GRACE_MS = 2 * HOUR_MS;

const LEAD_MS: Record<ReminderKind, number> = { "24h": 24 * HOUR_MS, "1h": HOUR_MS };

export type ReminderState = "sent" | "due" | "pending" | "skipped";

/**
 * State of ONE reminder of ONE booking at `now`. Pure.
 *  - sent:    its flag is set.
 *  - skipped: it will never be sent (booking not confirmed, class started, booked after the
 *             nominal time, or the grace window is over).
 *  - due:     now is inside [startsAt - lead, startsAt - lead + grace].
 *  - pending: the window has not opened yet.
 */
export function reminderState(
  b: ReminderCandidate,
  kind: ReminderKind,
  now: Date,
  options: { graceMs?: number } = {},
): ReminderState {
  const graceMs = options.graceMs ?? REMINDER_GRACE_MS;
  const sentAt = kind === "24h" ? b.reminder24hSentAt : b.reminder1hSentAt;
  if (sentAt) return "sent";
  if (b.status !== "confirmed") return "skipped";

  const start = b.startsAt.getTime();
  const nowMs = now.getTime();
  if (nowMs >= start) return "skipped";

  const nominal = start - LEAD_MS[kind];
  if (b.createdAt.getTime() > nominal) return "skipped";
  if (nowMs < nominal) return "pending";
  if (nowMs > nominal + graceMs) return "skipped";
  return "due";
}

/**
 * Decides which reminders are due at `now`. Pure.
 *
 * Per booking and per kind (24h / 1h), a reminder is due when ALL hold (see reminderState):
 *  - the booking is `confirmed` (pending/cancelled/completed/no_show never get one);
 *  - the class has not started (`now < startsAt`);
 *  - now is inside [startsAt - lead, startsAt - lead + grace];
 *  - its sent flag is still null;
 *  - the booking was not created after the nominal time (a student who just booked does not
 *    need a "24h" notice for a class they booked minutes ago).
 * If both kinds are due in the same tick only the 1h one is returned.
 */
export function dueReminders(
  bookings: ReminderCandidate[],
  now: Date,
  options: { graceMs?: number } = {},
): DueReminder[] {
  const out: DueReminder[] = [];
  for (const b of bookings) {
    if (reminderState(b, "1h", now, options) === "due") out.push({ bookingId: b.id, kind: "1h" });
    else if (reminderState(b, "24h", now, options) === "due") out.push({ bookingId: b.id, kind: "24h" });
  }
  return out;
}

/** "jesus@gmail.com" -> "j***@gmail.com". Used wherever an address is shown to an admin list. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

interface Copy {
  subject: (shortDate: string) => string;
  greeting: (name: string) => string;
  intro: string;
  dateLabel: string;
  linkLabel: string;
  dashboardIntro: string;
  dashboardCta: string;
  policy: string | null;
  closing: string;
}

const COPY: Record<Locale, Record<ReminderKind, Copy>> = {
  es: {
    "24h": {
      subject: (d) => `Recordatorio de tu clase: ${d}`,
      greeting: (n) => `Hola ${n},`,
      intro: "Tu clase empieza en 24 horas.",
      dateLabel: "Fecha",
      linkLabel: "Link de videollamada",
      dashboardIntro: "Puedes ver los detalles de tu clase en tu panel:",
      dashboardCta: "Ir a mi panel",
      policy:
        "Recuerda que las clases solo se pueden cancelar o reprogramar con más de 24 horas de anticipación, así que a partir de ahora ya no es posible hacerlo desde el panel. Si tienes una emergencia, responde a este correo.",
      closing: "¡Nos vemos en clase!",
    },
    "1h": {
      subject: () => "Tu clase empieza en 1 hora",
      greeting: (n) => `Hola ${n},`,
      intro: "Tu clase empieza en 1 hora. Entra con el siguiente enlace unos minutos antes.",
      dateLabel: "Fecha",
      linkLabel: "Link de videollamada",
      dashboardIntro: "También puedes encontrar tu clase en tu panel:",
      dashboardCta: "Ir a mi panel",
      policy: null,
      closing: "¡Nos vemos en un momento! Si no puedes asistir, responde a este correo.",
    },
  },
  en: {
    "24h": {
      subject: (d) => `Class reminder: ${d}`,
      greeting: (n) => `Hi ${n},`,
      intro: "Your class starts in 24 hours.",
      dateLabel: "Date",
      linkLabel: "Video call link",
      dashboardIntro: "You can see your class details in your dashboard:",
      dashboardCta: "Go to my dashboard",
      policy:
        "Please note that classes can only be cancelled or rescheduled more than 24 hours in advance, so from now on this is no longer possible from the dashboard. If you have an emergency, reply to this email.",
      closing: "See you in class!",
    },
    "1h": {
      subject: () => "Your class starts in 1 hour",
      greeting: (n) => `Hi ${n},`,
      intro: "Your class starts in 1 hour. Join with the link below a few minutes early.",
      dateLabel: "Date",
      linkLabel: "Video call link",
      dashboardIntro: "You can also find your class in your dashboard:",
      dashboardCta: "Go to my dashboard",
      policy: null,
      closing: "See you in a moment! If you can't make it, reply to this email.",
    },
  },
};

export interface ReminderEmailInput {
  kind: ReminderKind;
  locale: Locale;
  studentName: string;
  startsAt: Date;
  meetLink: string | null;
  /** Campus origin; the dashboard link is `${siteUrl}/dashboard`. */
  siteUrl: string;
}

export function buildReminderEmail(input: ReminderEmailInput): { subject: string; html: string; text: string } {
  const locale = normalizeLocale(input.locale);
  const c = COPY[locale][input.kind];

  const subject = c.subject(formatClassDateTimeShort(input.startsAt, locale));
  const when = `${formatClassDateTime(input.startsAt, locale)} (${zoneLabel(locale)})`;
  const dashboardUrl = `${input.siteUrl.replace(/\/+$/, "")}/dashboard`;

  const safeName = escapeHtml(input.studentName);
  const safeWhen = escapeHtml(when);
  const safeDashboard = escapeHtml(dashboardUrl);
  const safeMeet = input.meetLink ? escapeHtml(input.meetLink) : null;

  const bodyHtml = `
    <p>${c.greeting(safeName)}</p>
    <p>${c.intro}</p>
    <p><strong>${c.dateLabel}:</strong> ${safeWhen}</p>
    ${safeMeet ? `<p><strong>${c.linkLabel}:</strong> <a href="${safeMeet}" style="color:${BRAND_COLOR};">${safeMeet}</a></p>` : ""}
    <p>${c.dashboardIntro}</p>
    <p style="margin:24px 0;">
      <a href="${safeDashboard}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${c.dashboardCta}</a>
    </p>
    ${c.policy ? `<p style="color:#8a939c; font-size:13px;">${c.policy}</p>` : ""}
    <p>${c.closing}</p>
  `;

  const text = [
    c.greeting(input.studentName),
    "",
    c.intro,
    `${c.dateLabel}: ${when}`,
    ...(input.meetLink ? [`${c.linkLabel}: ${input.meetLink}`] : []),
    "",
    `${c.dashboardIntro} ${dashboardUrl}`,
    ...(c.policy ? ["", c.policy] : []),
    "",
    c.closing,
  ].join("\n");

  return { subject, html: renderEmailHtml({ title: escapeHtml(subject), bodyHtml, locale }), text };
}
