import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No Postgres is available to unit tests, so these are static assertions on the SQL text.
// The behavior itself (old->new grant mapping) was verified by hand on a throwaway Postgres container.
const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0015_wp_product_source.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

function at(re: RegExp): number {
  const i = sql.search(re);
  expect(i, `pattern ${re} not found`).toBeGreaterThanOrEqual(0);
  return i;
}

describe("migration 0015_wp_product_source", () => {
  it("is registered in the journal after every other migration (highest `when`)", () => {
    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe("0015_wp_product_source");
    expect(last.idx).toBe(15);
    const maxOther = Math.max(...journal.entries.slice(0, -1).map((e: { when: number }) => e.when));
    expect(last.when).toBeGreaterThan(maxOther);
  });

  it("re-points content_access BEFORE overwriting products ids and before any rename", () => {
    const grants = at(/UPDATE "ecommerce"\."content_access"/);
    const products = at(/UPDATE "ecommerce"\."products"/);
    const firstRename = at(/RENAME COLUMN/);
    expect(grants).toBeLessThan(products);
    expect(products).toBeLessThan(firstRename);
  });

  it("joins grants to products on the OLD strapi columns", () => {
    const grantsStmt = sql.slice(at(/UPDATE "ecommerce"\."content_access"/), at(/UPDATE "ecommerce"\."products"/));
    expect(grantsStmt).toMatch(/ca\."strapi_document_id" = p\."strapi_document_id"/);
    expect(grantsStmt).toMatch(/ca\."strapi_content_type" = p\."strapi_content_type"/);
  });

  it.each([
    ["single-session", "75"],
    ["basic", "76"],
    ["starter", "77"],
    ["plus", "78"],
  ])("maps slug %s to WP post id %s in both backfills", (slug, id) => {
    const re = new RegExp(`\\('${slug}', '${id}'\\)`, "g");
    expect(sql.match(re)).toHaveLength(2);
  });

  it("renames all four columns, the unique constraint and the products index", () => {
    for (const re of [
      /"products" RENAME COLUMN "strapi_document_id" TO "external_id"/,
      /"products" RENAME COLUMN "strapi_content_type" TO "content_type"/,
      /"content_access" RENAME COLUMN "strapi_document_id" TO "external_id"/,
      /"content_access" RENAME COLUMN "strapi_content_type" TO "content_type"/,
      /RENAME CONSTRAINT "products_strapi_document_id_unique" TO "products_external_id_unique"/,
      /"idx_products_strapi_doc_id" RENAME TO "idx_products_external_id"/,
    ]) {
      expect(sql).toMatch(re);
    }
  });

  it("does not open its own transaction (drizzle wraps the migration in one)", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
  });
});
