import { describe, it, expect } from "vitest";
import { toActiveCreditDto } from "../active-credits";

const base = { creditId: "c1", productName: "Starter", expiresAt: null as Date | null };

describe("toActiveCreditDto", () => {
  it("returns totalCredits and usedCredits so the campus can compute what is left", () => {
    const dto = toActiveCreditDto({ ...base, totalCredits: 8, usedCredits: 3 });

    expect(dto.totalCredits).toBe(8);
    expect(dto.usedCredits).toBe(3);
  });

  it("keeps remaining consistent with total - used", () => {
    const dto = toActiveCreditDto({ ...base, totalCredits: 8, usedCredits: 3 });

    expect(dto.remaining).toBe(5);
    expect(dto.totalCredits - dto.usedCredits).toBe(dto.remaining);
  });

  it("never reports a negative remaining when used exceeds total", () => {
    const dto = toActiveCreditDto({ ...base, totalCredits: 1, usedCredits: 2 });

    expect(dto.remaining).toBe(0);
  });

  it("passes the identity fields through unchanged", () => {
    const expiresAt = new Date("2026-12-31T00:00:00Z");
    const dto = toActiveCreditDto({ creditId: "c9", productName: "Plus", totalCredits: 12, usedCredits: 0, expiresAt });

    expect(dto).toMatchObject({ creditId: "c9", productName: "Plus", expiresAt });
  });
});
