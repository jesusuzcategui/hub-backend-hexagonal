import { describe, it, expect } from "vitest";
import { AppError, appErrorBody } from "../errors";

describe("appErrorBody", () => {
  it("keeps the { error: { code, message } } shape when there are no details", () => {
    expect(appErrorBody(new AppError(404, "NOT_FOUND", "nope"))).toEqual({ error: { code: "NOT_FOUND", message: "nope" } });
  });

  it("adds machine-readable details when present", () => {
    const err = new AppError(409, "INSUFFICIENT_CREDITS", "not enough", { required: 8, balance: 5 });
    expect(err.details).toEqual({ required: 8, balance: 5 });
    expect(appErrorBody(err)).toEqual({
      error: { code: "INSUFFICIENT_CREDITS", message: "not enough", details: { required: 8, balance: 5 } },
    });
  });
});
