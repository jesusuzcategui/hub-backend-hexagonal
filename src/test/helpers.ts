import { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { eq } from "drizzle-orm";
import { accounts } from "../db/schema";

let _app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!_app) {
    _app = buildApp();
    await _app.ready();
  }
  return _app;
}

export async function closeApp(): Promise<void> {
  if (_app) {
    await _app.close();
    _app = null;
  }
}

export async function deleteTestUser(app: FastifyInstance, email: string): Promise<void> {
  await app.drizzle.delete(accounts).where(eq(accounts.email, email.toLowerCase()));
}

export function extractCookie(headers: Record<string, string | string[]>, name: string): string | null {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.split(";")[0].split("=").slice(1).join("=");
}
