import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

const SECRET = "s".repeat(40);

vi.mock("../../../config/env", () => ({
  env: { wp: { url: "https://wp.example.test", appUser: "u", appPass: "p", webhookSecret: "s".repeat(40) } },
}));

const syncAllProducts = vi.fn();
vi.mock("../products.service", () => ({
  syncAllProducts: (...args: unknown[]) => syncAllProducts(...args),
  listProducts: vi.fn(),
  getProductBySlug: vi.fn(),
}));

import { productsRoutes } from "../products.routes";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.decorate("authenticate", async () => {});
  app.decorateRequest("user", null as any);
  await app.register(productsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  syncAllProducts.mockReset();
  syncAllProducts.mockResolvedValue(4);
});

describe("POST /webhooks/wp", () => {
  it("rejects a missing secret header with 401 and does not sync", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/wp", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(syncAllProducts).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret with 401 and does not sync", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/wp",
      headers: { "x-webhook-secret": "wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(syncAllProducts).not.toHaveBeenCalled();
  });

  it("rejects a same-length wrong secret with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/wp",
      headers: { "x-webhook-secret": "t".repeat(40) },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(syncAllProducts).not.toHaveBeenCalled();
  });

  it("runs a full sync on a valid secret and ignores the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/wp",
      headers: { "x-webhook-secret": SECRET },
      payload: { anything: "ignored", id: 999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, synced: 4 });
    expect(syncAllProducts).toHaveBeenCalledTimes(1);
  });

  it("works with an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/wp",
      headers: { "x-webhook-secret": SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(syncAllProducts).toHaveBeenCalledTimes(1);
  });

  it("the old Strapi route no longer exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/strapi",
      headers: { "x-strapi-signature": SECRET },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
