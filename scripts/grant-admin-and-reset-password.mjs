// One-off ops script. Run INSIDE the running container (has DATABASE_URL +
// argon2/pg as production deps already installed):
//   docker exec -it <container> node scripts/grant-admin-and-reset-password.mjs
//
// Looks up the account by email (ANY role — this is what promotes a plain
// "user" to "admin"), sets its role to admin if it isn't already, and sets
// a new password. Prompts interactively — nothing is hardcoded, nothing is
// logged. Same argon2 params as src/modules/auth/auth.service.ts.
//
// Renamed from reset-admin-password.mjs: that version only matched accounts
// already `role='admin'`, which is safe for a rotate-password-only flow but
// useless for bootstrapping the FIRST admin on a fresh environment (e.g.
// staging had zero admin accounts, only a role='user' account) — this is
// the superset that also grants the role, so it replaces it.

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
stdout.write("Account email to grant admin + reset password: ");
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

const existing = await pool.query(
  `SELECT id, email, role FROM users.accounts WHERE email = $1`,
  [email],
);

if (existing.rowCount === 0) {
  console.error(`No account found with email ${email}. Nothing changed.`);
  await pool.end();
  process.exit(1);
}

const previousRole = existing.rows[0].role;
const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

const result = await pool.query(
  `UPDATE users.accounts SET role = 'admin', password_hash = $1 WHERE email = $2 RETURNING id, email, role`,
  [passwordHash, email],
);

const { id, email: updatedEmail, role } = result.rows[0];
console.log(
  previousRole === "admin"
    ? `Password updated for ${updatedEmail} (id: ${id}, already admin).`
    : `${updatedEmail} (id: ${id}) promoted ${previousRole} -> ${role} and password updated.`,
);
await pool.end();
