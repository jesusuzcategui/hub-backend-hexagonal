import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config/env", () => ({
  env: {
    wp: {
      url: "https://wp.example.test",
      appUser: "Jesus Uzcategui",
      appPass: "abcd efgh ijkl mnop",
      webhookSecret: "x".repeat(32),
    },
  },
}));

import { mapWpItem, fetchWpProducts } from "../wp";

function item(overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  return {
    id: 76,
    slug: "basic",
    status: "publish",
    title: { raw: "Basic", rendered: "Basic" },
    nodus_fields: {
      name: "Basic",
      slug: "basic",
      description: "Four classes",
      productType: "class_package",
      priceCOP: 230000,
      priceUSD: 57.5,
      isActive: true,
      metadata: '{"creditsCount":4}',
      feature_image: null,
      landing_software: null,
      ...fields,
    },
    ...overrides,
  };
}

describe("mapWpItem", () => {
  const warn = vi.fn();
  beforeEach(() => warn.mockReset());

  it.each([
    ["single-session", 15, 1500, 60000, 1],
    ["basic", 57.5, 5750, 230000, 4],
    ["starter", 107.5, 10750, 410000, 8],
    ["plus", 152.5, 15250, 610000, 12],
  ])("maps %s with exact cents (%s USD -> %s)", (slug, usd, cents, cop, credits) => {
    const out = mapWpItem(
      item({ slug }, { slug, priceUSD: usd, priceCOP: cop, metadata: JSON.stringify({ creditsCount: credits }) }),
      warn,
    );
    expect(out).not.toBeNull();
    expect(out!.priceUsd).toBe(cents);
    expect(out!.priceCop).toBe(cop);
    expect(out!.metadata).toEqual({ creditsCount: credits });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rounds floating point noise (19.99 -> 1999)", () => {
    const out = mapWpItem(item({}, { priceUSD: 19.99 }), warn);
    expect(out!.priceUsd).toBe(1999);
  });

  it("uses the WP post id as external id (string) and content type", () => {
    const out = mapWpItem(item(), warn)!;
    expect(out.externalId).toBe("76");
    expect(out.slug).toBe("basic");
    expect(out.name).toBe("Basic");
    expect(out.description).toBe("Four classes");
    expect(out.isActive).toBe(true);
  });

  it("accepts metadata already as an object", () => {
    const out = mapWpItem(item({}, { metadata: { creditsCount: 4 } }), warn);
    expect(out!.metadata).toEqual({ creditsCount: 4 });
  });

  it("preserves extra metadata keys", () => {
    const out = mapWpItem(item({}, { metadata: '{"creditsCount":4,"badge":"hot"}' }), warn);
    expect(out!.metadata).toEqual({ creditsCount: 4, badge: "hot" });
  });

  it.each([
    ["empty string", ""],
    ["null", null],
    ["invalid JSON", "{not json"],
    ["json array", "[1,2]"],
    ["no creditsCount", '{"badge":"x"}'],
    ["zero credits", '{"creditsCount":0}'],
    ["non numeric credits", '{"creditsCount":"many"}'],
  ])("skips product and warns when metadata is %s", (_label, metadata) => {
    const out = mapWpItem(item({}, { metadata }), warn);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("basic");
  });

  it("marks isActive false when the field is false", () => {
    expect(mapWpItem(item({}, { isActive: false }), warn)!.isActive).toBe(false);
  });

  it("marks inactive when post status is not publish", () => {
    expect(mapWpItem(item({ status: "draft" }), warn)!.isActive).toBe(false);
  });

  it("skips items without a slug or numeric id", () => {
    expect(mapWpItem(item({ slug: "" }, { slug: "" }), warn)).toBeNull();
    expect(mapWpItem(item({ id: undefined }), warn)).toBeNull();
  });

  it("falls back to post slug/title when nodus_fields lacks them", () => {
    const out = mapWpItem(item({}, { name: "", slug: "" }), warn)!;
    expect(out.slug).toBe("basic");
    expect(out.name).toBe("Basic");
  });
});

describe("fetchWpProducts", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function ok(body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  it("calls the REST endpoint with Basic auth (space in login preserved) and a timeout signal", async () => {
    fetchMock.mockResolvedValueOnce(ok([item()]));
    const out = await fetchWpProducts();
    expect(out).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe("https://wp.example.test/wp-json/wp/v2/nodus_product");
    expect(u.searchParams.get("per_page")).toBe("100");
    expect(u.searchParams.get("status")).toBe("publish");
    expect(u.searchParams.get("context")).toBe("edit");
    const expected = "Basic " + Buffer.from("Jesus Uzcategui:abcd efgh ijkl mnop").toString("base64");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expected });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("follows pagination using X-WP-TotalPages", async () => {
    fetchMock
      .mockResolvedValueOnce(ok([item()], { "X-WP-TotalPages": "2" }))
      .mockResolvedValueOnce(ok([item({ id: 77, slug: "starter" }, { slug: "starter" })], { "X-WP-TotalPages": "2" }));
    const out = await fetchWpProducts();
    expect(out.map((p) => p.slug)).toEqual(["basic", "starter"]);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("page")).toBe("2");
  });

  it("drops invalid items but returns the valid ones, reporting valid external ids", async () => {
    fetchMock.mockResolvedValueOnce(ok([item(), item({ id: 99, slug: "bad" }, { slug: "bad", metadata: "" })]));
    const out = await fetchWpProducts();
    expect(out.map((p) => p.externalId)).toEqual(["76"]);
  });

  it("throws a clear error without credentials on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    let msg = "";
    try {
      await fetchWpProducts();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("401");
    expect(msg).not.toContain("abcd efgh");
    expect(msg).not.toContain("Jesus");
    expect(msg).not.toContain(Buffer.from("Jesus Uzcategui:abcd efgh ijkl mnop").toString("base64"));
  });

  it("throws a clear error without credentials on network failure/timeout", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom Authorization: Basic SECRETSTUFF"));
    let msg = "";
    try {
      await fetchWpProducts();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/WP request failed/);
    expect(msg).not.toContain("SECRETSTUFF");
  });

  it("throws when the response is not an array", async () => {
    fetchMock.mockResolvedValueOnce(ok({ code: "rest_no_route" }));
    await expect(fetchWpProducts()).rejects.toThrow(/unexpected/i);
  });
});
