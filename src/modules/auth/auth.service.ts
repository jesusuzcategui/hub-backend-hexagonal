import { eq, and, isNull, gt } from "drizzle-orm";
import * as argon2 from "argon2";
import { randomBytes, createHash } from "crypto";
import { FastifyInstance } from "fastify";
import { accounts, refreshTokens } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import type { RegisterInput, LoginInput } from "./auth.schemas";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export async function registerUser(
  fastify: FastifyInstance,
  input: RegisterInput,
): Promise<{ accessToken: string; refreshToken: string }> {
  const db = fastify.drizzle;

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.email, input.email.toLowerCase()),
    columns: { id: true },
  });
  if (existing) {
    throw new AppError(409, "EMAIL_TAKEN", "Email already registered");
  }

  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

  const [account] = await db
    .insert(accounts)
    .values({
      email: input.email.toLowerCase(),
      passwordHash,
      displayName: input.displayName,
    })
    .returning({ id: accounts.id, role: accounts.role });

  return issueTokens(fastify, account.id, account.role);
}

export async function loginUser(
  fastify: FastifyInstance,
  input: LoginInput,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.email, input.email.toLowerCase()), eq(accounts.isActive, true)),
    columns: { id: true, role: true, passwordHash: true },
  });

  if (!account?.passwordHash) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const valid = await argon2.verify(account.passwordHash, input.password);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  return issueTokens(fastify, account.id, account.role, meta);
}

export async function refreshTokens_service(
  fastify: FastifyInstance,
  rawToken: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const db = fastify.drizzle;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const now = new Date();
  const token = await db.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.tokenHash, tokenHash),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, now),
    ),
    columns: { id: true, userId: true, familyId: true, revokedAt: true },
  });

  if (!token) {
    // Possible reuse — revoke entire family if token hash found but already revoked
    const stolen = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
      columns: { familyId: true },
    });
    if (stolen) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(eq(refreshTokens.familyId, stolen.familyId));
    }
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token invalid or expired");
  }

  // Revoke used token
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(eq(refreshTokens.id, token.id));

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, token.userId), eq(accounts.isActive, true)),
    columns: { id: true, role: true },
  });
  if (!account) {
    throw new AppError(401, "ACCOUNT_INACTIVE", "Account not found or inactive");
  }

  return issueTokens(fastify, account.id, account.role, meta, token.familyId);
}

export async function logoutUser(
  fastify: FastifyInstance,
  rawToken: string,
): Promise<void> {
  const db = fastify.drizzle;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

async function issueTokens(
  fastify: FastifyInstance,
  userId: string,
  role: "user" | "admin",
  meta: { userAgent?: string; ipAddress?: string } = {},
  existingFamilyId?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const db = fastify.drizzle;
  const { raw, hash } = generateRefreshToken();
  const familyId = existingFamilyId ?? randomBytes(16).toString("hex");

  const expiresAt = new Date(Date.now() + env.jwt.refreshExpirySeconds * 1000);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hash,
    familyId,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
    expiresAt,
  });

  const accessToken = await fastify.signAccessToken({ sub: userId, role });
  return { accessToken, refreshToken: raw };
}
