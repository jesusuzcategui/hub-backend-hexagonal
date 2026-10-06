import { describe, it, expect } from "vitest";
import {
  buildBookingConfirmedEmail,
  buildBookingCancelledEmail,
  buildWeeklySlotChangeEmail,
  buildSeriesConfirmationEmail,
  buildSeriesCancellationEmail,
} from "../student-emails";

const startsAt = new Date("2026-10-10T20:00:00Z");

describe("buildBookingConfirmedEmail", () => {
  const base = { studentName: "Ana", productName: "Plan Básico", startsAt, meetLink: "https://talk.example.com/clase-1" };

  it("keeps the Spanish copy for es", () => {
    const { subject, html } = buildBookingConfirmedEmail({ ...base, locale: "es" });
    expect(subject).toBe("✅ Clase confirmada");
    expect(html).toContain("Hola Ana");
    expect(html).toContain("está confirmada");
    expect(html).toContain("(Colombia)");
    expect(html).toContain("sábado");
  });

  it("renders English for en, with the zone and no Spanish", () => {
    const { subject, html } = buildBookingConfirmedEmail({ ...base, locale: "en" });
    expect(subject).toBe("✅ Class confirmed");
    expect(html).toContain("Hi Ana");
    expect(html).toContain("is confirmed");
    expect(html).toContain("Saturday");
    expect(html).toContain("Bogotá");
    expect(html).not.toMatch(/Hola|confirmada|videollamada/);
  });

  it("escapes names and product names", () => {
    const { html } = buildBookingConfirmedEmail({ ...base, studentName: "<b>x</b>", productName: "<i>p</i>", locale: "en" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>p</i>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("buildBookingCancelledEmail", () => {
  it("renders es and en, with an escaped optional reason", () => {
    const es = buildBookingCancelledEmail({ studentName: "Ana", startsAt, reason: "<u>x</u>", locale: "es" });
    expect(es.subject).toBe("❌ Clase cancelada");
    expect(es.html).toContain("Motivo");
    expect(es.html).not.toContain("<u>x</u>");
    const en = buildBookingCancelledEmail({ studentName: "Ana", startsAt, reason: null, locale: "en" });
    expect(en.subject).toBe("❌ Class cancelled");
    expect(en.html).toContain("has been cancelled");
    expect(en.html).toContain("credit has been refunded");
    expect(en.html).not.toMatch(/Motivo|Reason|Hola/);
  });
});

describe("buildWeeklySlotChangeEmail", () => {
  it("renders es and en", () => {
    const es = buildWeeklySlotChangeEmail({ studentName: "Ana", startsAt, locale: "es" });
    expect(es.subject).toBe("📅 Cambio en el horario recurrente de tus asesorías");
    expect(es.html).toContain("Hola Ana");
    const en = buildWeeklySlotChangeEmail({ studentName: "Ana", startsAt, locale: "en" });
    expect(en.subject).toBe("📅 Change to your recurring session schedule");
    expect(en.html).toContain("Hi Ana");
    expect(en.html).not.toMatch(/Hola|horario/);
  });
});

describe("buildSeriesConfirmationEmail", () => {
  const dates = [new Date("2026-10-12T11:00:00Z"), new Date("2026-10-14T11:00:00Z"), new Date("2026-10-19T11:00:00Z")];
  const base = { studentName: "Ana", dates, creditsUsed: 3, balanceRemaining: 2, dashboardUrl: "https://campus.test/dashboard" };

  it("lists every date once, in Bogota time with the zone, in Spanish", () => {
    const { subject, html } = buildSeriesConfirmationEmail({ ...base, locale: "es" });
    expect(subject).toBe("✅ Tus 3 clases están confirmadas");
    expect(html).toContain("Hola Ana");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("lunes");
    expect(html).toContain("miércoles");
    expect(html).toContain("6:00");
    expect(html).toContain("hora de Bogotá, UTC-5");
    expect(html).toContain("Créditos usados:</strong> 3");
    expect(html).toContain("Créditos restantes:</strong> 2");
    expect(html).toContain('href="https://campus.test/dashboard"');
    expect(html).not.toMatch(/Hi |Class|credits used/);
  });

  it("renders English for en with no Spanish", () => {
    const { subject, html } = buildSeriesConfirmationEmail({ ...base, locale: "en" });
    expect(subject).toBe("✅ Your 3 classes are confirmed");
    expect(html).toContain("Hi Ana");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("Monday");
    expect(html).toContain("Bogotá time, UTC-5");
    expect(html).toContain("Credits used:</strong> 3");
    expect(html).toContain("Credits remaining:</strong> 2");
    expect(html).toContain('href="https://campus.test/dashboard"');
    expect(html).not.toMatch(/Hola|clases|Créditos|videollamada/);
  });

  it("uses singular wording for one class", () => {
    expect(buildSeriesConfirmationEmail({ ...base, dates: [dates[0]], creditsUsed: 1, locale: "en" }).subject).toBe("✅ Your class is confirmed");
    expect(buildSeriesConfirmationEmail({ ...base, dates: [dates[0]], creditsUsed: 1, locale: "es" }).subject).toBe("✅ Tu clase está confirmada");
  });

  it("escapes the name, the optional note and the dashboard url", () => {
    const { html } = buildSeriesConfirmationEmail({
      ...base,
      studentName: "<script>alert(1)</script>",
      meetLinkNote: "<img src=x onerror=alert(2)>",
      dashboardUrl: 'https://x.test/"><script>alert(3)</script>',
      locale: "es",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("falls back to es for an unknown locale", () => {
    expect(buildSeriesConfirmationEmail({ ...base, locale: "fr" as never }).subject).toContain("confirmadas");
  });
});

describe("buildSeriesCancellationEmail", () => {
  const cancelled = [new Date("2026-10-19T11:00:00Z"), new Date("2026-10-26T11:00:00Z")];
  const kept = [new Date("2026-10-13T11:00:00Z")];
  const base = { studentName: "Ana", cancelledDates: cancelled, keptDates: kept, creditsRefunded: 2, dashboardUrl: "https://campus.test/dashboard" };

  it("renders es: cancelled dates, kept dates, refunded credits", () => {
    const { subject, html } = buildSeriesCancellationEmail({ ...base, locale: "es" });
    expect(subject).toBe("❌ Serie de clases cancelada");
    expect(html).toContain("Hola Ana");
    expect(html).toContain("Créditos reintegrados:</strong> 2");
    expect(html).toContain("Clases canceladas");
    expect(html).toContain("Clases que se mantienen");
    expect(html).toContain("hora de Bogotá, UTC-5");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('href="https://campus.test/dashboard"');
  });

  it("renders en, and omits the kept section when nothing was kept", () => {
    const { subject, html } = buildSeriesCancellationEmail({ ...base, keptDates: [], locale: "en" });
    expect(subject).toBe("❌ Class series cancelled");
    expect(html).toContain("Hi Ana");
    expect(html).toContain("Credits refunded:</strong> 2");
    expect(html).toContain("Cancelled classes");
    expect(html).not.toContain("will stay");
    expect(html).not.toMatch(/Hola|Créditos|Clases/);
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("escapes the student name", () => {
    const { html } = buildSeriesCancellationEmail({ ...base, studentName: "<b>x</b>", locale: "en" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
