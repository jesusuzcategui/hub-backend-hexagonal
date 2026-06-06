import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { eq } from "drizzle-orm";
import { accounts } from "../../../db/schema";

const TEST_USER = { email: "user-test@hub.test", password: "Password123!", displayName: "Test User" };
const TEST_ADMIN = { email: "admin-test@hub.test", password: "Password123!", displayName: "Test Admin" };

let app: FastifyInstance;
let userToken: string;
let adminToken: string;
let userId: string;
let adminId: string;

beforeAll(async () => {
  app = await getApp();

  await deleteTestUser(app, TEST_USER.email);
  await deleteTestUser(app, TEST_ADMIN.email);

  // Register user
  const regUser = await app.inject({
    method: "POST",
    url: "/auth/register",
    body: TEST_USER,
  });
  userToken = regUser.json().data.accessToken;
  userId = JSON.parse(Buffer.from(userToken.split(".")[1], "base64url").toString()).sub;

  // Register admin + promote
  const regAdmin = await app.inject({
    method: "POST",
    url: "/auth/register",
    body: TEST_ADMIN,
  });
  adminToken = regAdmin.json().data.accessToken;
  adminId = JSON.parse(Buffer.from(adminToken.split(".")[1], "base64url").toString()).sub;

  await app.drizzle.update(accounts).set({ role: "admin" }).where(eq(accounts.id, adminId));
  // Re-login to get fresh token with admin role
  const loginAdmin = await app.inject({
    method: "POST",
    url: "/auth/login",
    body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
  });
  adminToken = loginAdmin.json().data.accessToken;
});

afterAll(async () => {
  await deleteTestUser(app, TEST_USER.email);
  await deleteTestUser(app, TEST_ADMIN.email);
  await closeApp();
});

describe("GET /users/me", () => {
  it("returns profile for authenticated user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.email).toBe(TEST_USER.email);
    expect(data.displayName).toBe(TEST_USER.displayName);
    expect(data.passwordHash).toBeUndefined();
  });

  it("returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /users/me", () => {
  it("updates displayName", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: { authorization: `Bearer ${userToken}` },
      body: { displayName: "Updated Name" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.displayName).toBe("Updated Name");
  });

  it("returns 400 with empty body", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: { authorization: `Bearer ${userToken}` },
      body: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 with invalid avatarUrl", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: { authorization: `Bearer ${userToken}` },
      body: { avatarUrl: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /users (admin)", () => {
  it("returns user list for admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((u: { email: string }) => u.email === TEST_USER.email)).toBe(true);
  });

  it("returns 403 for non-admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/users" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /users/:id/role (admin)", () => {
  it("changes user role", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { role: "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.role).toBe("admin");

    // revert
    await app.inject({
      method: "PATCH",
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { role: "user" },
    });
  });

  it("returns 400 when admin tries to change own role", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/users/${adminId}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { role: "user" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CANNOT_CHANGE_OWN_ROLE");
  });

  it("returns 400 with invalid role", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { role: "superuser" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for non-admin", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/users/${userId}/role`,
      headers: { authorization: `Bearer ${userToken}` },
      body: { role: "admin" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /users/:id (admin)", () => {
  it("deactivates a user", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/users/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    // verify isActive=false in DB
    const row = await app.drizzle.query.accounts.findFirst({
      where: eq(accounts.id, userId),
      columns: { isActive: true },
    });
    expect(row?.isActive).toBe(false);
  });

  it("returns 400 when admin tries to deactivate self", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/users/${adminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CANNOT_DEACTIVATE_SELF");
  });

  it("returns 403 for non-admin", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/users/${userId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
