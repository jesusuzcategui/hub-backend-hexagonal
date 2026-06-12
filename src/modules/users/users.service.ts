import { eq, asc } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { accounts, refreshTokens } from "../../db/schema";
import { AppError } from "../../lib/errors";
import type { UpdateProfileInput, ChangeRoleInput } from "./users.schemas";

export async function getProfile(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      emailVerified: true,
      createdAt: true,
    },
  });

  if (!account) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  return account;
}

export async function updateProfile(
  fastify: FastifyInstance,
  userId: string,
  input: UpdateProfileInput,
) {
  const db = fastify.drizzle;

  if (!input.displayName && !input.avatarUrl) {
    throw new AppError(400, "NOTHING_TO_UPDATE", "Provide at least one field to update");
  }

  const [updated] = await db
    .update(accounts)
    .set({
      ...(input.displayName && { displayName: input.displayName }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, userId))
    .returning({
      id: accounts.id,
      email: accounts.email,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      role: accounts.role,
      emailVerified: accounts.emailVerified,
      createdAt: accounts.createdAt,
    });

  if (!updated) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  return updated;
}

export async function listUsers(fastify: FastifyInstance) {
  const db = fastify.drizzle;

  return db.query.accounts.findMany({
    columns: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      emailVerified: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: [asc(accounts.createdAt)],
  });
}

export async function changeUserRole(
  fastify: FastifyInstance,
  targetId: string,
  actorId: string,
  input: ChangeRoleInput,
) {
  if (targetId === actorId) {
    throw new AppError(400, "CANNOT_CHANGE_OWN_ROLE", "Cannot change your own role");
  }

  const db = fastify.drizzle;

  const [updated] = await db
    .update(accounts)
    .set({ role: input.role, updatedAt: new Date() })
    .where(eq(accounts.id, targetId))
    .returning({ id: accounts.id, role: accounts.role });

  if (!updated) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  return updated;
}

export async function deactivateUser(
  fastify: FastifyInstance,
  targetId: string,
  actorId: string,
) {
  if (targetId === actorId) {
    throw new AppError(400, "CANNOT_DEACTIVATE_SELF", "Cannot deactivate your own account");
  }

  const db = fastify.drizzle;

  const [updated] = await db
    .update(accounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(accounts.id, targetId))
    .returning({ id: accounts.id, isActive: accounts.isActive });

  if (!updated) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }
}

export async function suspendAccount(fastify: FastifyInstance, userId: string) {
  const db = fastify.drizzle;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, userId),
    columns: { id: true, status: true },
  });

  if (!account) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  if (account.status === "suspended") throw new AppError(400, "ALREADY_SUSPENDED", "Account is already suspended");
  if (account.status === "blocked") throw new AppError(403, "ACCOUNT_BLOCKED", "Account is blocked — contact support");
  if (account.status === "deleted") throw new AppError(403, "ACCOUNT_DELETED", "Account not found");

  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ status: "suspended", isActive: false, suspendedAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, userId));

    // Revoke all refresh tokens so the session ends
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  });
}
