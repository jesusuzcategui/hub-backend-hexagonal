import { describe, it, expect } from "vitest";
import {
  buildBookingConfirmedEmail,
  buildBookingCancelledEmail,
  buildWeeklySlotChangeEmail,
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
