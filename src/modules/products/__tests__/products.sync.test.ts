import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../../config/env", () => ({
  env: { wp: { url: "https://wp.example.test", appUser: "u", appPass: "p", webhookSecret: "x".repeat(32) } },
}));

import { syncAllProducts } from "../products.service";
import { products } from "../../../db/schema";
import type { WpProduct } from "../../../lib/wp";

const dialect = new PgDialect();

function wpProduct(overrides: Partial<WpProduct> = {}): WpProduct {
  return {
    externalId: "76",
    slug: "basic",
    name: "Basic",
    description: null,
    priceCop: 230000,
    priceUsd: 5750,
    isActive: true,
    metadata: { creditsCount: 4 },
    ...overrides,
  };
}

function fakeFastify() {
  const inserts: Array<{ values: any; conflict: any }> = [];
  const updates: Array<{ set: any; where: any }> = [];
  const drizzle = {
    insert: vi.fn(() => ({
      values: (values: any) => ({
        onConflictDoUpdate: async (conflict: any) => {
          inserts.push({ values, conflict });
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (set: any) => ({
        where: async (where: any) => {
          updates.push({ set, where });
        },
      }),
    })),
  };
  return { fastify: { drizzle } as any, inserts, updates };
}

describe("syncAllProducts (WP source)", () => {
  let fetcher: ReturnType<typeof vi.fn<() => Promise<WpProduct[]>>>;
  beforeEach(() => {
    fetcher = vi.fn<() => Promise<WpProduct[]>>();
  });

  it("upserts each WP product keyed on external_id with content type nodus_product", async () => {
    fetcher.mockResolvedValue([wpProduct(), wpProduct({ externalId: "77", slug: "starter", priceUsd: 10750 })]);
    const { fastify, inserts } = fakeFastify();

    const count = await syncAllProducts(fastify, fetcher);

    expect(count).toBe(2);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].conflict.target).toBe(products.externalId);
    expect(inserts[0].values).toMatchObject({
      externalId: "76",
      contentType: "nodus_product",
      slug: "basic",
      priceCop: 230000,
      priceUsd: 5750,
      isActive: true,
      metadata: { creditsCount: 4 },
    });
    expect(inserts[0].conflict.set).toMatchObject({ externalId: "76", contentType: "nodus_product" });
  });

  it("deactivates products missing from the WP feed", async () => {
    fetcher.mockResolvedValue([wpProduct(), wpProduct({ externalId: "77", slug: "starter" })]);
    const { fastify, updates } = fakeFastify();

    await syncAllProducts(fastify, fetcher);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ isActive: false });
    const q = dialect.sqlToQuery(updates[0].where);
    expect(q.sql).toMatch(/not in/i);
    expect(q.params).toEqual(expect.arrayContaining(["76", "77"]));
  });

  it("keeps inactive WP products in the feed set and upserts them as inactive", async () => {
    fetcher.mockResolvedValue([wpProduct({ isActive: false })]);
    const { fastify, inserts, updates } = fakeFastify();

    await syncAllProducts(fastify, fetcher);

    expect(inserts[0].values.isActive).toBe(false);
    expect(dialect.sqlToQuery(updates[0].where).params).toContain("76");
  });

  it("does not deactivate anything when the feed is empty (guards against a broken WP)", async () => {
    fetcher.mockResolvedValue([]);
    const { fastify, inserts, updates } = fakeFastify();

    const count = await syncAllProducts(fastify, fetcher);

    expect(count).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("propagates fetch failures without touching the DB", async () => {
    fetcher.mockRejectedValue(new Error("WP request failed: HTTP 500"));
    const { fastify, inserts, updates } = fakeFastify();

    await expect(syncAllProducts(fastify, fetcher)).rejects.toThrow(/WP request failed/);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
