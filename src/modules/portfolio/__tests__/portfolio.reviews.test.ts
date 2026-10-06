import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

const envState = vi.hoisted(() => ({
  strapi: { url: undefined as string | undefined, token: undefined as string | undefined },
}));

vi.mock("../../../config/env", () => ({
  env: {
    get strapi() {
      return envState.strapi;
    },
    mentoring: { teacherId: "t", portfolioOrigin: undefined },
  },
}));

import { submitReview } from "../portfolio.service";
import { AppError } from "../../../lib/errors";

const review = { author_name: "Ana", rating: 5, message: "Great mentoring session" } as any;

describe("submitReview without Strapi configuration", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    envState.strapi = { url: undefined, token: undefined };
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fails with an explicit 503 AppError and never calls fetch", async () => {
    await expect(submitReview(review)).rejects.toMatchObject({
      statusCode: 503,
      code: "REVIEWS_UNAVAILABLE",
    });
    await expect(submitReview(review)).rejects.toBeInstanceOf(AppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still posts to Strapi when it is configured", async () => {
    envState.strapi = { url: "https://cms.example.test", token: "tok" };
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 201 }));
    await submitReview(review);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://cms.example.test/api/reviews");
  });
});

describe("POST /public/reviews error mapping", () => {
  it("returns 503 when the service reports reviews unavailable", async () => {
    vi.resetModules();
    const { AppError: FreshAppError } = await import("../../../lib/errors");
    vi.doMock("../portfolio.service.js", () => ({
      createMentoringRequest: vi.fn(),
      getPublicSlots: vi.fn(),
      submitReview: vi.fn().mockRejectedValue(new FreshAppError(503, "REVIEWS_UNAVAILABLE", "Reviews are temporarily unavailable")),
    }));
    vi.doMock("../portfolio.captcha.js", () => ({ verifyCaptchaToken: vi.fn() }));
    const { portfolioRoutes } = await import("../portfolio.routes");

    const app = Fastify();
    await app.register(portfolioRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/public/reviews",
      payload: { author_name: "Ana", rating: 5, message: "Great mentoring session" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("REVIEWS_UNAVAILABLE");
    await app.close();
  });
});
