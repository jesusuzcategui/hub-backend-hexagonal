import { env } from "../config/env";

export interface StrapiProduct {
  id: number;
  documentId: string;
  name: string;
  slug: string;
  description: string | null;
  productType: "class_package" | "course" | "software";
  priceCOP: number;
  priceUSD: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

interface StrapiListResponse<T> {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
}

async function strapiRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${env.strapi.url}${path}`, {
    headers: { Authorization: `Bearer ${env.strapi.token}` },
  });

  if (!res.ok) {
    throw new Error(`Strapi request failed: ${res.status} ${path}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchAllProducts(): Promise<StrapiProduct[]> {
  const res = await strapiRequest<StrapiListResponse<StrapiProduct>>(
    "/api/products?pagination[limit]=100&filters[isActive][$eq]=true",
  );
  return res.data;
}

export async function fetchProductByDocumentId(documentId: string): Promise<StrapiProduct | null> {
  const res = await strapiRequest<StrapiListResponse<StrapiProduct>>(
    `/api/products?filters[documentId][$eq]=${documentId}`,
  );
  return res.data[0] ?? null;
}
