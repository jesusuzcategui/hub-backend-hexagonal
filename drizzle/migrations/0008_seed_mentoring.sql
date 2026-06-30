-- Seed teacher account and weekly slots (idempotent)
INSERT INTO "users"."accounts" ("id", "email", "display_name", "email_verified", "is_active")
VALUES ('f4636de6-a1bd-4eb0-be87-d160ccb82c53', 'hola@jesusuzcategui.com', 'Jesus Uzcategui', true, true)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "scheduling"."weekly_slots" ("id", "teacher_id", "day_of_week", "start_time", "end_time", "is_active") VALUES
  ('a1b2c3d4-0001-4000-a000-000000000001', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 1, '05:00', '07:30', true),
  ('a1b2c3d4-0002-4000-a000-000000000002', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 1, '17:00', '19:30', true),
  ('a1b2c3d4-0003-4000-a000-000000000003', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 2, '05:00', '07:30', true),
  ('a1b2c3d4-0004-4000-a000-000000000004', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 2, '17:00', '19:30', true),
  ('a1b2c3d4-0005-4000-a000-000000000005', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 3, '05:00', '07:30', true),
  ('a1b2c3d4-0006-4000-a000-000000000006', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 3, '17:00', '19:30', true),
  ('a1b2c3d4-0007-4000-a000-000000000007', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 4, '05:00', '07:30', true),
  ('a1b2c3d4-0008-4000-a000-000000000008', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 4, '17:00', '19:30', true),
  ('a1b2c3d4-0009-4000-a000-000000000009', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 5, '05:00', '07:30', true),
  ('a1b2c3d4-0010-4000-a000-000000000010', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 5, '17:00', '19:30', true),
  ('a1b2c3d4-0011-4000-a000-000000000011', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 6, '07:00', '12:30', true),
  ('a1b2c3d4-0012-4000-a000-000000000012', 'f4636de6-a1bd-4eb0-be87-d160ccb82c53', 6, '15:00', '18:00', true)
ON CONFLICT ("id") DO NOTHING;
