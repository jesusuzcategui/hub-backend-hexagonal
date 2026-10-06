import { describe, it, expect } from "vitest";
import { planSync, maskSummary, type ExistingBlock } from "../sync-plan";
import type { BusyInterval } from "../ics";

const t = (s: string) => new Date(`2026-10-${s}:00Z`);
const win = { start: t("05T00:00"), end: new Date(Date.parse("2026-10-05T00:00:00Z") + 16 * 7 * 86_400_000) };

const iv = (key: string, from: string, to: string, summary: string | null = "Title"): BusyInterval => ({
  key,
  startsAt: t(from),
  endsAt: t(to),
  summary,
  allDay: false,
});
const row = (id: string, key: string, from: string, to: string, summary: string | null = "Title"): ExistingBlock => ({
  id,
  externalKey: key,
  startsAt: t(from),
  endsAt: t(to),
  externalSummary: summary,
});

describe("planSync", () => {
  it("inserts intervals with unknown keys", () => {
    const plan = planSync([], [iv("a|1", "08T11:00", "08T12:00")], win);
    expect(plan.insert.map((i) => i.key)).toEqual(["a|1"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("leaves identical rows alone (they are only touched, not counted as updates)", () => {
    const plan = planSync([row("r1", "a|1", "08T11:00", "08T12:00")], [iv("a|1", "08T11:00", "08T12:00")], win);
    expect(plan.insert).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual(["r1"]);
  });

  it("updates a row whose times or title changed", () => {
    const moved = planSync([row("r1", "a|1", "08T11:00", "08T12:00")], [iv("a|1", "08T13:00", "08T14:00")], win);
    expect(moved.update.map((u) => u.id)).toEqual(["r1"]);
    const renamed = planSync([row("r1", "a|1", "08T11:00", "08T12:00")], [iv("a|1", "08T11:00", "08T12:00", "New title")], win);
    expect(renamed.update.map((u) => u.id)).toEqual(["r1"]);
  });

  it("removes rows inside the window that were not seen", () => {
    const plan = planSync([row("r1", "gone|1", "08T11:00", "08T12:00")], [], win);
    expect(plan.remove).toEqual(["r1"]);
  });

  it("keeps unseen rows that are entirely in the past or beyond the window", () => {
    const far: ExistingBlock = { ...row("far", "far|1", "07T10:00", "07T11:00"), startsAt: new Date("2027-06-01T10:00:00Z"), endsAt: new Date("2027-06-01T11:00:00Z") };
    const plan = planSync([row("old", "old|1", "01T11:00", "01T12:00"), far], [], win);
    expect(plan.remove).toEqual([]);
  });

  it("removes an unseen row that is still in progress at the window start", () => {
    const plan = planSync([row("cur", "cur|1", "04T23:00", "05T01:00")], [], win);
    expect(plan.remove).toEqual(["cur"]);
  });

  it("a seen key keeps its row even when the new times fall outside the window start (moved instance)", () => {
    const plan = planSync([row("r1", "a|1", "08T11:00", "08T12:00")], [iv("a|1", "20T11:00", "20T12:00")], win);
    expect(plan.remove).toEqual([]);
    expect(plan.update).toHaveLength(1);
  });
});

describe("maskSummary", () => {
  it("keeps the first two characters and hides the rest", () => {
    expect(maskSummary("Clase de ingles")).toBe("Cl***");
  });
  it("never reveals short titles in full", () => {
    expect(maskSummary("A")).toBe("A***");
    expect(maskSummary("AB")).toBe("AB***");
  });
  it("counts code points, not UTF-16 units", () => {
    expect(maskSummary("😀😀😀")).toBe("😀😀***");
  });
  it("null or blank stays null", () => {
    expect(maskSummary(null)).toBeNull();
    expect(maskSummary("   ")).toBeNull();
  });
});
