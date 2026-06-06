import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getApp, closeApp, deleteTestUser, extractCookie } from "../../../test/helpers";
import type { FastifyInstance } from "fastify";

const TEST_EMAIL = "auth_test@hub.test";
const TEST_PASSWORD = "TestPass123!";
const TEST_NAME = "Auth Tester";

describe("POST /auth/register", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  afterEach(async () => {
    await deleteTestUser(app, TEST_EMAIL);
  });

  it("creates account and returns access token + refresh cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.accessToken).toBeTypeOf("string");
    expect(body.data.accessToken.split(".")).toHaveLength(3);

    const cookie = extractCookie(res.headers as Record<string, string[]>, "refresh_token");
    expect(cookie).not.toBeNull();
  });

  it("returns 409 when email already registered", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("returns 400 for invalid email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "notanemail", password: TEST_PASSWORD, displayName: TEST_NAME },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for short password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: "short", displayName: TEST_NAME },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /auth/login", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });
  });

  afterAll(async () => {
    await deleteTestUser(app, TEST_EMAIL);
    await closeApp();
  });

  it("returns access token + refresh cookie on valid credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.accessToken).toBeTypeOf("string");

    const cookie = extractCookie(res.headers as Record<string, string[]>, "refresh_token");
    expect(cookie).not.toBeNull();
  });

  it("returns 401 on wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_EMAIL, password: "wrongpassword" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 401 on non-existent email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@nowhere.com", password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("GET /auth/me", () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await getApp();
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });
    accessToken = res.json().data.accessToken;
  });

  afterAll(async () => {
    await deleteTestUser(app, TEST_EMAIL);
    await closeApp();
  });

  it("returns userId and role with valid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.userId).toBeTypeOf("string");
    expect(body.data.role).toBe("user");
  });

  it("returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MISSING_TOKEN");
  });

  it("returns 401 with malformed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer notavalidtoken" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });
});

describe("POST /auth/refresh", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  afterAll(async () => {
    await deleteTestUser(app, TEST_EMAIL);
    await closeApp();
  });

  it("issues new access token and rotates refresh cookie", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });
    const firstRefreshToken = extractCookie(
      regRes.headers as Record<string, string[]>,
      "refresh_token",
    )!;

    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: firstRefreshToken },
    });

    expect(refreshRes.statusCode).toBe(200);
    const newAccessToken = refreshRes.json().data.accessToken;
    expect(newAccessToken).toBeTypeOf("string");

    const newRefreshToken = extractCookie(
      refreshRes.headers as Record<string, string[]>,
      "refresh_token",
    );
    expect(newRefreshToken).not.toBeNull();
    expect(newRefreshToken).not.toBe(firstRefreshToken);
  });

  it("returns 401 on reused refresh token (family revocation)", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `reuse_${TEST_EMAIL}`, password: TEST_PASSWORD, displayName: TEST_NAME },
    });
    const originalToken = extractCookie(
      regRes.headers as Record<string, string[]>,
      "refresh_token",
    )!;

    // First refresh — valid
    await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: originalToken },
    });

    // Reuse original — should trigger family revocation
    const reuseRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: originalToken },
    });

    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.json().error.code).toBe("INVALID_REFRESH_TOKEN");

    await deleteTestUser(app, `reuse_${TEST_EMAIL}`);
  });

  it("returns 401 without cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MISSING_REFRESH_TOKEN");
  });
});

describe("POST /auth/logout", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  afterAll(async () => {
    await deleteTestUser(app, TEST_EMAIL);
    await closeApp();
  });

  it("returns 204 and clears cookie", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_NAME },
    });
    const refreshToken = extractCookie(
      regRes.headers as Record<string, string[]>,
      "refresh_token",
    )!;

    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { refresh_token: refreshToken },
    });

    expect(logoutRes.statusCode).toBe(204);

    // Refresh after logout must fail
    const postLogoutRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshToken },
    });
    expect(postLogoutRefresh.statusCode).toBe(401);
  });
});
