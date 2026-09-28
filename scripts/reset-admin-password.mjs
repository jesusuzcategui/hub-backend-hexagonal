// One-off ops script. Run INSIDE the running container (has DATABASE_URL +
// argon2/pg as production deps already installed):
//   docker exec -it <container> node scripts/reset-admin-password.mjs
//
// Prompts for email + new password interactively — nothing is hardcoded,
// nothing is logged. Same argon2 params as src/modules/auth/auth.service.ts.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import argon2 from "argon2";
import { Pool } from "pg";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

// Two sequential rl.question() calls hang/never-resolve when stdin is a
// non-TTY pipe (Node closes the interface on EOF between calls). An async
// iterator over the interface reads both lines reliably in either mode
// (interactive TTY or piped), so use that instead.
const rl = createInterface({ input: stdin, output: stdout });
const answers = [];
stdout.write("Admin email to reset: ");
for await (const line of rl) {
  answers.push(line.trim());
  if (answers.length === 1) stdout.write("New password: ");
  else break;
}
const [email, password] = answers;

if (!email || password.length < 8) {
  console.error("Email required and password must be at least 8 chars. Aborting.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

const result = await pool.query(
  `UPDATE users.accounts SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id, email`,
  [passwordHash, email],
);

if (result.rowCount === 0) {
  console.error(`No admin account found with email ${email}. Nothing changed.`);
  await pool.end();
  process.exit(1);
}

console.log(`Password updated for ${result.rows[0].email} (id: ${result.rows[0].id}).`);
await pool.end();
