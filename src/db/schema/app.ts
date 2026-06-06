import { index, integer, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "drizzle-orm/pg-core";
import { accounts } from "./users";

export const appSchema = pgSchema("app");

export const requestLogs = appSchema.table(
  "request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => accounts.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: smallint("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_request_logs_user_id").on(table.userId),
    index("idx_request_logs_created_at").on(table.createdAt),
    index("idx_request_logs_status").on(table.statusCode),
  ],
);

export const auditLogs = appSchema.table(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => accounts.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetId: uuid("target_id"),
    targetType: text("target_type"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_logs_actor_id").on(table.actorId),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_created_at").on(table.createdAt),
  ],
);
