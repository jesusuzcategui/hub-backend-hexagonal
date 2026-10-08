import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

const envState = vi.hoisted(() => ({ captcha: { siteKey: "site", privateKey: "priv" } as { siteKey?: string; privateKey?: string } }));

vi.mock("../../../config/env", () => ({
  env: {
    get captcha() {
      return envState.captcha;
    },
    mentoring: { teacherId: "t", portfolioOrigin: undefined },
  },
}));

import { verifyCaptchaToken } from "../portfolio.captcha";
import { AppError } from "../../../lib/errors";

describe("verifyCaptchaToken error codes", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    envState.captcha = { siteKey: "site", privateKey: "priv" };
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("missing token: 400 CAPTCHA_REQUIRED", async () => {
    await expect(verifyCaptchaToken(undefined)).rejects.toMatchObject({ statusCode: 400, code: "CAPTCHA_REQUIRED" });
    await expect(verifyCaptchaToken(undefined)).rejects.toBeInstanceOf(AppError);
  });

  it("rejected token: 400 CAPTCHA_FAILED without echoing the provider reason", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: "invalid-input-response" }), { status: 200 }));
    const err = await verifyCaptchaToken("tok").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect([err.statusCode, err.code]).toEqual([400, "CAPTCHA_FAILED"]);
    expect(err.message).not.toContain("invalid-input-response");
  });

  it("never writes the private key or the token to any log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await verifyCaptchaToken("secret-visitor-token");

    const logged = [log, info, warn, error].flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(logged).not.toContain("priv");
    expect(logged).not.toContain("secret-visitor-token");
  });
});

describe("POST /public/book error envelope", () => {
  const payload = { slotId: "s_20990101_0600", name: "Ana Mentor", email: "ana@example.test", whatsapp: "+573001112233", type: "wordpress" };

  async function build(createMentoringRequest: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("../portfolio.service.js", () => ({ createMentoringRequest, getPublicSlots: vi.fn(), submitReview: vi.fn() }));
    vi.doMock("../portfolio.captcha.js", () => ({ verifyCaptchaToken: vi.fn() }));
    const { portfolioRoutes } = await import("../portfolio.routes");
    const { AppError: A, appErrorBody: body } = await import("../../../lib/errors");
    const app = Fastify();
    app.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof A) return reply.status(error.statusCode).send(body(error));
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    });
    await app.register(portfolioRoutes);
    return { app, A };
  }

  it("invalid body: 400 VALIDATION_ERROR with a string message and the field errors under details", async () => {
    const { app } = await build(vi.fn());
    const res = await app.inject({ method: "POST", url: "/public/book", payload: { slotId: "x" } });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(typeof error.message).toBe("string");
    expect(error.details.fieldErrors).toBeDefined();
    await app.close();
  });

  it.each([
    [409, "SLOT_TAKEN"],
    [409, "SLOT_BLOCKED"],
    [404, "SLOT_NOT_FOUND"],
  ])("service AppError %i %s passes through in the envelope", async (status, code) => {
    const { app, A } = await build(vi.fn());
    const { createMentoringRequest } = await import("../portfolio.service.js");
    (createMentoringRequest as any).mockRejectedValueOnce(new A(status, code, "english fallback"));
    const res = await app.inject({ method: "POST", url: "/public/book", payload });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: "english fallback" } });
    await app.close();
  });

  it("an unexpected error is a generic 500 INTERNAL_ERROR, never its raw message", async () => {
    const { app } = await build(vi.fn().mockRejectedValue(new Error("connection to 10.0.0.5 refused")));
    const res = await app.inject({ method: "POST", url: "/public/book", payload });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toContain("10.0.0.5");
    await app.close();
  });
});
