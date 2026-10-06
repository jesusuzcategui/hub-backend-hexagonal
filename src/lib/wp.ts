import { env } from "../config/env";

export const WP_PRODUCT_CONTENT_TYPE = "nodus_product";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;

export interface WpProduct {
  /** WordPress post id, as text. Stable external key. */
  externalId: string;
  slug: string;
  name: string;
  description: string | null;
  priceCop: number;
  /** Cents. */
  priceUsd: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

type Warn = (message: string) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function titleOf(title: unknown): string | null {
  if (typeof title === "string") return nonEmptyString(title);
  const t = asRecord(title);
  return t ? (nonEmptyString(t.raw) ?? nonEmptyString(t.rendered)) : null;
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (asRecord(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * Maps one WP REST item to a product. Returns null (and warns) when the item
 * cannot be sold safely, e.g. without a valid creditsCount.
 */
export function mapWpItem(raw: unknown, warn: Warn = console.warn): WpProduct | null {
  const item = asRecord(raw);
  if (!item) return null;

  const fields = asRecord(item.nodus_fields) ?? {};
  const id = item.id;
  const slug = nonEmptyString(fields.slug) ?? nonEmptyString(item.slug);

  if (typeof id !== "number" || !Number.isInteger(id) || !slug) {
    warn(`WP product skipped: missing id or slug (id=${String(id)})`);
    return null;
  }

  const metadata = parseMetadata(fields.metadata);
  if (!metadata || !isPositiveInt(metadata.creditsCount)) {
    warn(`WP product "${slug}" (id ${id}) skipped: metadata missing a valid creditsCount`);
    return null;
  }

  const priceUsdDollars = Number(fields.priceUSD);
  const priceCop = Number(fields.priceCOP);

  return {
    externalId: String(id),
    slug,
    name: nonEmptyString(fields.name) ?? titleOf(item.title) ?? slug,
    description: nonEmptyString(fields.description),
    priceCop: Number.isFinite(priceCop) ? Math.round(priceCop) : 0,
    priceUsd: Number.isFinite(priceUsdDollars) ? Math.round(priceUsdDollars * 100) : 0,
    isActive: toBool(fields.isActive) && item.status === "publish",
    metadata,
  };
}

function authHeader(): string {
  const token = Buffer.from(`${env.wp.appUser}:${env.wp.appPass}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchPage(page: number): Promise<{ items: unknown[]; totalPages: number }> {
  const url = new URL("/wp-json/wp/v2/nodus_product", env.wp.url);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("status", "publish");
  url.searchParams.set("context", "edit");
  url.searchParams.set("page", String(page));

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: authHeader(), Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The underlying error is deliberately dropped: it may echo request details.
    throw new Error("WP request failed: network error or timeout");
  }

  if (!res.ok) {
    throw new Error(`WP request failed: HTTP ${res.status} on /wp-json/wp/v2/nodus_product`);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new Error("WP request failed: unexpected response shape (expected a JSON array)");
  }

  const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
  return { items: body, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1 };
}

/** Fetches published nodus_product posts and returns the valid, mapped ones. */
export async function fetchWpProducts(): Promise<WpProduct[]> {
  const out: WpProduct[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const res = await fetchPage(page);
    totalPages = res.totalPages;
    for (const raw of res.items) {
      const mapped = mapWpItem(raw);
      if (mapped) out.push(mapped);
    }
    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES);

  return out;
}
