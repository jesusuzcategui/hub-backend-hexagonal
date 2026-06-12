import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const usersSchema = pgSchema("users");

export const userRoleEnum = usersSchema.enum("user_role", ["user", "admin", "teacher"]);
export const providerTypeEnum = usersSchema.enum("provider_type", ["google", "github"]);
export const accountStatusEnum = usersSchema.enum("account_status", ["active", "suspended", "blocked", "deleted"]);

export const accounts = usersSchema.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    role: userRoleEnum("role").notNull().default("user"),
    emailVerified: boolean("email_verified").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    status: accountStatusEnum("status").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_accounts_email").on(table.email),
    index("idx_accounts_status").on(table.status),
  ],
);

export const providers = usersSchema.table(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: providerTypeEnum("provider").notNull(),
    providerUid: text("provider_uid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_provider_uid").on(table.provider, table.providerUid),
    index("idx_providers_lookup").on(table.provider, table.providerUid),
  ],
);

export const refreshTokens = usersSchema.table(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    familyId: uuid("family_id").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_refresh_tokens_family").on(table.familyId),
  ],
);
