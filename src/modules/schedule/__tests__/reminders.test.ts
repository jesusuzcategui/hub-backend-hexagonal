import { describe, it, expect } from "vitest";
import {
  dueReminders,
  buildReminderEmail,
  REMINDER_GRACE_MS,
  reminderState,
  maskEmail,
  type ReminderCandidate,
} from "../reminders";

const H = 3_600_000;
const startsAt = new Date("2026-10-10T20:00:00Z"); // 15:00 in Bogota
const at = (hoursBeforeStart: number) => new Date(startsAt.getTime() - hoursBeforeStart * H);

function booking(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: "b1",
    status: "confirmed",
    startsAt,
    createdAt: at(72),
    reminder24hSentAt: null,
    reminder1hSentAt: null,
    ...over,
  };
}

describe("dueReminders", () => {
  it("sends nothing before the 24h mark", () => {
    expect(dueReminders([booking()], at(24.01))).toEqual([]);
  });

  it("sends the 24h reminder exactly at the 24h mark and during the 2h grace", () => {
    expect(dueReminders([booking()], at(24))).toEqual([{ bookingId: "b1", kind: "24h" }]);
    expect(dueReminders([booking()], at(23))).toEqual([{ bookingId: "b1", kind: "24h" }]);
    expect(dueReminders([booking()], at(22))).toEqual([{ bookingId: "b1", kind: "24h" }]);
  });

  it("drops the 24h reminder once the grace is over (service was down)", () => {
    expect(REMINDER_GRACE_MS).toBe(2 * H);
    expect(dueReminders([booking()], at(21.99))).toEqual([]);
    expect(dueReminders([booking()], at(10))).toEqual([]);
  });

  it("sends the 1h reminder at the 1h mark and until the class starts, never after", () => {
    expect(dueReminders([booking()], at(1.01))).toEqual([]);
    expect(dueReminders([booking()], at(1))).toEqual([{ bookingId: "b1", kind: "1h" }]);
    expect(dueReminders([booking()], at(0.1))).toEqual([{ bookingId: "b1", kind: "1h" }]);
    expect(dueReminders([booking()], startsAt)).toEqual([]);
    expect(dueReminders([booking()], new Date(startsAt.getTime() + 1))).toEqual([]);
  });

  it("does not repeat a reminder that already has its flag", () => {
    const sent = new Date();
    expect(dueReminders([booking({ reminder24hSentAt: sent })], at(23))).toEqual([]);
    expect(dueReminders([booking({ reminder1hSentAt: sent })], at(0.5))).toEqual([]);
  });

  it("still sends the 1h reminder when only the 24h one was sent", () => {
    expect(dueReminders([booking({ reminder24hSentAt: new Date() })], at(0.5))).toEqual([{ bookingId: "b1", kind: "1h" }]);
  });

  it("skips the 24h reminder when the booking was created after the 24h mark", () => {
    expect(dueReminders([booking({ createdAt: at(23.5) })], at(23))).toEqual([]);
    // created exactly at the mark is not "after"
    expect(dueReminders([booking({ createdAt: at(24) })], at(24))).toEqual([{ bookingId: "b1", kind: "24h" }]);
  });

  it("skips the 1h reminder when the booking was created after the 1h mark, but keeps it when only the 24h mark was missed", () => {
    expect(dueReminders([booking({ createdAt: at(0.5) })], at(0.4))).toEqual([]);
    expect(dueReminders([booking({ createdAt: at(5) })], at(0.5))).toEqual([{ bookingId: "b1", kind: "1h" }]);
  });

  it("only reminds confirmed bookings", () => {
    for (const status of ["pending", "cancelled", "completed", "no_show"] as const) {
      expect(dueReminders([booking({ status })], at(23))).toEqual([]);
      expect(dueReminders([booking({ status })], at(0.5))).toEqual([]);
    }
  });

  it("sends only the 1h one when both would be due at the same tick", () => {
    // a class created far ahead where both windows overlap (only possible if grace were widened,
    // but the rule is enforced independently of the grace constant)
    const out = dueReminders([booking()], at(0.5), { graceMs: 30 * H });
    expect(out).toEqual([{ bookingId: "b1", kind: "1h" }]);
  });

  it("handles several bookings independently", () => {
    const a = booking({ id: "a" });
    const b = booking({ id: "b", startsAt: new Date(startsAt.getTime() + 3 * 24 * H), createdAt: at(100) });
    expect(dueReminders([a, b], at(23))).toEqual([{ bookingId: "a", kind: "24h" }]);
  });
});

describe("buildReminderEmail", () => {
  const base = {
    studentName: "Ana",
    startsAt,
    meetLink: "https://talk.example.com/clase-abc",
    siteUrl: "https://campus.example.com/",
  };

  it("renders the 24h reminder in Spanish with the Bogota time, zone, link and dashboard", () => {
    const { subject, html, text } = buildReminderEmail({ ...base, kind: "24h", locale: "es" });
    expect(subject).toMatch(/^Recordatorio de tu clase: /);
    expect(subject).toMatch(/3:00/);
    expect(html).toContain("lang=\"es\"");
    expect(html).toContain("Hola Ana");
    expect(html).toContain("Bogotá");
    expect(html).toContain("UTC-5");
    expect(html).toContain('href="https://talk.example.com/clase-abc"');
    expect(html).toContain('href="https://campus.example.com/dashboard"');
    expect(html).toMatch(/24 horas/);
    expect(text).toContain("https://talk.example.com/clase-abc");
    expect(text).toContain("https://campus.example.com/dashboard");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("renders the 24h reminder in English", () => {
    const { subject, html } = buildReminderEmail({ ...base, kind: "24h", locale: "en" });
    expect(subject).toMatch(/^Class reminder: /);
    expect(html).toContain("lang=\"en\"");
    expect(html).toContain("Hi Ana");
    expect(html).toContain("Bogotá");
    expect(html).toMatch(/24 hours/);
    expect(html).not.toMatch(/Hola|Recordatorio|videollamada/);
  });

  it("has distinct 1h subjects in both languages", () => {
    expect(buildReminderEmail({ ...base, kind: "1h", locale: "es" }).subject).toBe("Tu clase empieza en 1 hora");
    expect(buildReminderEmail({ ...base, kind: "1h", locale: "en" }).subject).toBe("Your class starts in 1 hour");
  });

  it("states the real cancellation rule in the 24h email and omits it from the 1h email", () => {
    // schedule.service.ts: students cannot cancel/reschedule when the class starts within 24h.
    expect(buildReminderEmail({ ...base, kind: "24h", locale: "es" }).html).toMatch(/más de 24 horas de anticipación/);
    expect(buildReminderEmail({ ...base, kind: "24h", locale: "en" }).html).toMatch(/more than 24 hours in advance/);
    expect(buildReminderEmail({ ...base, kind: "1h", locale: "es" }).html).not.toMatch(/cancelar/);
    expect(buildReminderEmail({ ...base, kind: "1h", locale: "en" }).html).not.toMatch(/cancel/);
  });

  it("escapes the student name, the link and the site url (no raw HTML from data)", () => {
    const { html, text } = buildReminderEmail({
      ...base,
      studentName: "<b>x</b>",
      meetLink: 'https://x.test/"><script>alert(1)</script>',
      siteUrl: 'https://c.test/"><img src=x onerror=alert(1)>',
      kind: "1h",
      locale: "en",
    });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(text).toContain("<b>x</b>"); // plain text is not HTML
  });

  it("omits the video-call line when there is no meet link", () => {
    const { html, text } = buildReminderEmail({ ...base, meetLink: null, kind: "1h", locale: "es" });
    expect(html).not.toMatch(/videollamada/i);
    expect(text).not.toMatch(/videollamada/i);
  });

  it("falls back to Spanish for an unknown locale", () => {
    const { subject } = buildReminderEmail({ ...base, kind: "1h", locale: "fr" as never });
    expect(subject).toBe("Tu clase empieza en 1 hora");
  });
});

describe("reminderState (used by the admin upcoming view)", () => {
  it("is pending before the window, due inside it, skipped after it", () => {
    expect(reminderState(booking(), "24h", at(30))).toBe("pending");
    expect(reminderState(booking(), "24h", at(23))).toBe("due");
    expect(reminderState(booking(), "24h", at(20))).toBe("skipped");
    expect(reminderState(booking(), "1h", at(5))).toBe("pending");
    expect(reminderState(booking(), "1h", at(0.5))).toBe("due");
    expect(reminderState(booking(), "1h", new Date(startsAt.getTime() + 1))).toBe("skipped");
  });
  it("is sent when the flag is set, regardless of the window", () => {
    expect(reminderState(booking({ reminder24hSentAt: new Date() }), "24h", at(5))).toBe("sent");
  });
  it("is skipped when booked after the nominal time, or when the booking is not confirmed", () => {
    expect(reminderState(booking({ createdAt: at(10) }), "24h", at(30))).toBe("skipped");
    expect(reminderState(booking({ status: "cancelled" }), "1h", at(5))).toBe("skipped");
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain only", () => {
    expect(maskEmail("jesus@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
  });
  it("never throws on garbage", () => {
    expect(maskEmail("nonsense")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });
});
