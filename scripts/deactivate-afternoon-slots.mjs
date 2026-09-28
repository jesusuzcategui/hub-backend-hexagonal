// One-off ops script. Run INSIDE the running container:
//   docker exec -it <container> node scripts/deactivate-afternoon-slots.mjs
//
// Pure Node (global fetch, Node 22) on purpose — the production image is
// node:22-alpine and does NOT have curl installed, so a shell+curl script
// would fail silently or need an extra apk add. Talks to the app on its own
// localhost port (no network hop needed since it runs in the same container).
//
// Prompts for admin email + password interactively — nothing hardcoded,
// nothing logged. Deactivates the 5 weekday-afternoon (17:00-19:30, Mon-Fri)
// weekly slots via PATCH /admin/weekly-slots/:id (blocks NEW bookings only;
// existing upcoming bookings are notified by email, not cancelled — see
// admin.service.ts#deactivateWeeklySlot). Then verifies by re-listing.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const BASE_URL = process.env.LOCAL_BASE_URL ?? "http://127.0.0.1:3000";

const AFTERNOON_SLOT_IDS = [
  "a1b2c3d4-0002-4000-a000-000000000002", // Lunes    17:00-19:30
  "a1b2c3d4-0004-4000-a000-000000000004", // Martes   17:00-19:30
  "a1b2c3d4-0006-4000-a000-000000000006", // Miercoles 17:00-19:30
  "a1b2c3d4-0008-4000-a000-000000000008", // Jueves   17:00-19:30
  "a1b2c3d4-0010-4000-a000-000000000010", // Viernes  17:00-19:30
];

// Two sequential rl.question() calls hang/never-resolve when stdin is a
// non-TTY pipe (Node closes the interface on EOF between calls). An async
// iterator over the interface reads both lines reliably in either mode
// (interactive TTY or piped), so use that instead.
const rl = createInterface({ input: stdin, output: stdout });
const answers = [];
stdout.write("Admin email: ");
for await (const line of rl) {
  answers.push(line.trim());
  if (answers.length === 1) stdout.write("Admin password: ");
  else break;
}
const [email, password] = answers;

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const { data } = await res.json();
  return data.accessToken;
}

async function deactivate(token, id) {
  const res = await fetch(`${BASE_URL}/admin/weekly-slots/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ isActive: false }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Deactivate ${id} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function main() {
  console.log("==> Logging in...");
  const token = await login();

  for (const id of AFTERNOON_SLOT_IDS) {
    const result = await deactivate(token, id);
    console.log(
      `==> ${id} -> isActive:${result.slot.isActive} (notifiedBookings: ${result.notifiedBookings})`,
    );
  }

  console.log("==> Verifying current state of the 5 targeted slots...");
  const res = await fetch(`${BASE_URL}/admin/weekly-slots`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { data: rows } = await res.json();
  for (const row of rows) {
    if (AFTERNOON_SLOT_IDS.includes(row.id)) {
      console.log(`    ${row.id} day=${row.dayOfWeek} ${row.startTime}-${row.endTime} isActive=${row.isActive}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
