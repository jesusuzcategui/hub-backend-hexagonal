# Platform Roadmap and Phase 1 Spec

Status: DRAFT for owner review. No code, migration, commit or push has been made for this document.
Date: 2026-10-07. Branch inspected: `staging` of `hub-backend-hexagonal` (read-only), plus the Nuxt campus at `/home/jesusu/Workspace/jesusuzcategui/node/jesusuzcategui-campus`.

How to read this: sections 1-4 are the roadmap, section 5 is the implementable Phase 1 spec, section 6 gives Phases 2-6 at medium depth, section 7 covers cross-cutting concerns, section 8 lists the decisions I need from you, section 9 lists risks and deferrals.

Conventions used below:
- "Verified" = I read the code. File references are `path:line` relative to the hub repo `src/` unless stated otherwise. Line numbers are as of this read and will drift.
- "Owner-reported" or "Not verified" = taken from the brief or inferred, not confirmed in code.
- The repo has no `docs/` folder today (the only planning doc is `hub-backend-plan.md` at the repo root, written in Spanish). I created `docs/product/` for this file. This document is in English as requested.

---

## 1. Vision and non-goals

### 1.1 Vision

A commercial-grade, replicable platform for people who give mentoring, advisory sessions and courses. One buyer = one deployment. The buyer gets:

- A public website integration (today an Astro portfolio, later WordPress/Shopify/Drupal/Joomla connectors) for pages, shop and pricing.
- A headless WordPress as the source of truth for content and product catalog.
- The hub backend: bookings, credits, payments, reminders, calendar sync, courses, entitlements.
- The campus (Nuxt SPA): the student, teacher and admin app.

Quality bar (binding, from the owner): correctness under load, durable background work with retries and failure visibility, swappable providers behind ports, observability, no hardwired owner identity. Extra infrastructure is acceptable when it earns its keep. Only the owner uses the system today, so there is room to change internals, but the campus and the Astro site depend on the current HTTP contract and must not break silently.

### 1.2 Non-goals (explicit)

- NOT a hosted multi-tenant SaaS. No tenant column on every table, no shared database between customers, no per-tenant billing. Each buyer runs their own instance (own DB, own Redis, own secrets). "Multi-teacher inside one instance" is in scope; "multi-customer in one instance" is not.
- NO Google Calendar and NO Outlook/Microsoft 365 integration now. The owner has no Google Workspace account. Phase 7 is a placeholder; the CalendarProvider port (Phase 2) only has to keep that door open. (See open decision 12 for one caveat on the Google constraint.)
- No marketplace features (teacher payouts, commissions, disputes). Payments land with the instance owner.
- No native mobile apps, no PWA in these phases (the existing scheduling roadmap puts PWA last).
- No DRM for video, no certificates, no live-streaming in Phase 5.
- No DB-editable RBAC editor. Roles and permissions are code-defined.

---

## 2. Current state (grounded)

### 2.1 Stack and runtime shape

- Fastify 5 + TypeScript, drizzle-orm 0.45 over a `pg` Pool, zod 4, node-cron, nodemailer, ioredis, jose (JWT), argon2 (`package.json`).
- One process does everything: HTTP, cron jobs (reminders every minute `plugins/reminders.ts`, payment re-verification every minute `plugins/paymentVerification.ts`, CalDAV sync every 5 minutes `plugins/calendarSync.ts`, account purge daily `plugins/autoPurge.ts`) and migrations at boot (`server.ts` calls `runMigrations()` before `listen`).
- Postgres schemas: `users`, `ecommerce`, `payments`, `scheduling`, `app` (`db/schema/*.ts`). Migrations are hand-written SQL files `0000`..`0019` in `drizzle/migrations/` with `meta/_journal.json`; the next one is `0020`. Last journal entry: idx 19, tag `0019_blocked_slots_caldav`, `when` = `1791590400000`. Each entry's `when` advances by exactly 86,400,000 ms (one day) from the previous, e.g. 0018 = 1791504000000.
- Redis is connected at boot (`plugins/redis.ts`) but I found no module using `fastify.redis` outside the plugin itself (`rg redis src` only matches `app.ts` and the plugin). The cart is DB-backed (`ecommerce.carts`), not Redis as `hub-backend-plan.md` says. Treat Redis as currently unused infrastructure.
- Postgres `Pool` is created with defaults (`plugins/postgres.ts`: `new Pool({ connectionString })`). pg's default max is 10 connections (library default, not set in this repo).
- There is no SIGTERM/SIGINT handler anywhere (`rg "SIGTERM|SIGINT|process.on" src` returns nothing). Fastify `onClose` hooks (cron `task.stop()`, pool end) therefore only run if something calls `app.close()`; on `docker stop` the process is killed by the default signal behavior.

### 2.2 Roles and auth

- DB enum `users.user_role` = `user | admin | teacher` (`db/schema/users.ts:5`). Default `user`.
- JWT payload type says `role: "user" | "admin"` (`plugins/jwt.ts:8`) but `issueTokens` accepts `"user" | "admin" | "teacher"` (`modules/auth/auth.service.ts:220`) and signs whatever the account has. So a teacher token exists at runtime but is mistyped.
- Access token is HS256 (symmetric), TTL 900 s default, refresh tokens are opaque, hashed, rotated by family (`auth.service.ts`, `env.ts`).
- Admin gate: `requireAdmin` is copy-pasted four times (`modules/admin/admin.routes.ts:56`, `modules/products/products.routes.ts:13`, `modules/users/users.routes.ts:12`, `modules/class-notes/class-notes.routes.ts:19`), each doing `request.user.role !== "admin"` -> 403. There is no permission abstraction.
- A `teacher` role account can be created today (`POST /admin/students` accepts `role: user|teacher`, `PATCH /admin/students/:id` accepts `user|teacher|admin`, `admin.routes.ts:64-120`), but it is a dead role: every admin route rejects it, `/users/:id/role` only allows `user|admin` (`users.schemas.ts:10`), and `listStudents` filters `role = 'user'` (`admin.service.ts:90`). Nothing grants a teacher any capability.
- Students and "everyone not admin" are the same thing in practice: schedule routes only use `fastify.authenticate` (`modules/schedule/schedule.routes.ts`), and "student not found" checks only exclude `role === "admin"` (`series.service.ts:51`, `admin.service.ts:103,149,610,705,719`). A teacher account can therefore be treated as a bookable student.
- Impersonation: `POST /admin/students/:id/impersonate` signs an access token with the target's own role and no impersonator claim (`admin.service.ts:145-152`). `app.audit_logs` exists in the schema but nothing writes to it (`rg auditLogs` outside `db/schema` returns nothing).
- Campus gating: `app/middleware/auth.ts` (token in localStorage, `fetchMe`) and `app/middleware/admin.ts` (`user.role !== 'admin'` -> `/dashboard`). `useSession.ts` types role as `'user' | 'admin'`. Nav is a binary admin-vs-student switch (`layouts/default.vue:23`). Login lands admins on `/admin/orders`, students on `/dashboard`.

### 2.3 Scheduling and credits

- `scheduling.weekly_slots` (teacher_id, day_of_week, start/end `HH:MM` text), `availabilities` (legacy one-off slots, teacher_id), `blocked_slots` (teacher_id, `source` manual|caldav, `external_key`), `bookings`, `booking_series`, `class_credits`, `class_notes`, `mentoring_requests` (`db/schema/scheduling.ts`).
- `bookings` has NO `teacher_id`. The teacher is only reachable through `weekly_slot_id -> weekly_slots.teacher_id` or `availability_id -> availabilities.teacher_id`.
- Every availability query ignores the teacher: `getAvailableSlots` selects all active weekly slots (`schedule.service.ts:117`), `checkOccurrenceInTx` blocks on ANY `blocked_slots` row (`schedule.service.ts:248`), series `classify` loads all active slots and all blocks (`series.service.ts:56`). Single-teacher is an implicit assumption, not a configured one.
- The public mentoring page is pinned to one teacher by env: `getPublicSlots` filters `weeklySlots.teacherId = env.mentoring.teacherId` (`modules/portfolio/portfolio.service.ts:141`). `MENTORING_TEACHER_ID` is a required env var (`config/env.ts:74`).
- Admin-created availability uses the logged-in admin's id as teacher (`admin.routes.ts:176` for blocked slots), while the CalDAV sync writes blocks for `MENTORING_TEACHER_ID` (`calendar-sync/config.ts:49`, `calendar-sync.service.ts:194`). These are the same person today; they would diverge with a second teacher.
- `seedMentoring` runs on EVERY boot via `runMigrations()` and inserts a hardwired account `hola@jesusuzcategui.com` / "Jesus Uzcategui" with id = `MENTORING_TEACHER_ID` if missing (default role, i.e. `user`) and the slots from `mentoring-availability.json` (`db/seed-mentoring.ts:24-58`, copied into the image by `Dockerfile`).
- Credits: one balance per student summed over non-expired blocks, earliest-expiry-first (`credit-balance.ts`, `schedule.service.ts getStudentCredits`). Credit blocks are tied to a product, not to a teacher.
- Booking concurrency is handled correctly: `pg_advisory_xact_lock(hashtext('booking-instant:<ms>'))` per instant, locks in ascending order (`schedule.service.ts lockBookingInstant`), `FOR UPDATE` on credit blocks, guarded `used_credits < total_credits` update. This is the part to preserve untouched.
- Hardwired policy/locale: `America/Bogota` offset logic and `-05:00` literals in slot generation (`schedule.service.ts`, `series.ts`), 24 h student cancel cutoff in two places (`schedule.service.ts:669,783`, `series.service.ts:32`), 1-hour slot chunks, Spanish admin email subject, "Clase — English" event summary, `@vanjex.dev` UID domain and `PRODID -//Hub Vanjex//EN` (`schedule.service.ts buildIcal`), Jitsi URL `https://talk.jesusuzcategui.com/<id>` hardcoded in `portfolio.service.ts:328` while class bookings use `env.jitsi.baseUrl`.

### 2.4 After-commit side effects today (the Phase 1 target)

Every one of these runs inline in the request, after the DB commit, wrapped in try/catch that only logs. If the process dies between commit and the side effect, or the provider is down, the side effect is lost with no record and no retry.

| # | Where | Side effects (all inline, sequential) |
|---|---|---|
| 1 | `schedule.service.ts createStudentBooking` (~522-640) | CalDAV PUT (+ UPDATE `gcal_event_id`), student email with `.ics` attachment, admin notification email (`notifyAdminsOfBooking`) |
| 2 | `schedule.service.ts cancelStudentBooking` (~695) | CalDAV DELETE, only `if (booking.gcalEventId)`. No student email |
| 3 | `schedule.service.ts rescheduleBookingInternal` (~730-770) | calls #1 for the new booking, then non-transactional status flip of the old one, availability release, CalDAV DELETE of the old event |
| 4 | `series.service.ts createSeries` (~227-275) | for each created booking (up to `MAX_SERIES_OCCURRENCES = 50`, `series.ts:14`): one CalDAV PUT, awaited sequentially, plus one `UPDATE gcal_event_id`; then one summary email. NO admin notification (unlike #1) |
| 5 | `series.service.ts cancelSeries` (~406-445) | per cancelled booking CalDAV DELETE (sequential), then one email |
| 6 | `admin.service.ts cancelBooking` (~280-320) | CalDAV DELETE, cancellation email to student |
| 7 | `admin.service.ts deactivateWeeklySlot` (~500-530) | a sequential loop of one email per affected future booking |
| 8 | `admin.service.ts createCheckoutLink` (~1007) and `cart.service.ts sendCartLinkEmail` (~125) | payment-link email |
| 9 | `payments.service.ts applySettlementSideEffects` (485-730) | credit grant, content access grant, fulfillment state flip (NOT wrapped in one transaction), set-password token insert + confirmation email (636), Umami `fetch` (650), coupon redemption counter, plus `notifyAdminsOfReviewNeeded` email (713; also called from `review-verification.service.ts:115`) |
| 10 | `portfolio.service.ts` public mentoring request (~340-420) | CalDAV PUT, admin email to a hardcoded `hola@jesusuzcategui.com`, client email with `.ics` |
| 11 | `contact.service.ts sendContactEmail` | one inline email to a hardcoded address; the controller returns HTTP 500 if SMTP fails (`contact.controller.ts`) |
| 12 | `auth.service.ts requestPasswordReset` (~164) | token insert + inline email; returns early on unknown email, so response time differs between registered and unregistered addresses (a timing side channel, observable from the code) |
| 13 | `plugins/reminders.ts` + `reminders.service.ts` | cron, not after-commit: atomic claim (`UPDATE ... SET flag = now WHERE id = $1 AND flag IS NULL RETURNING id`) then inline SMTP; on failure the claim is cleared so the next tick retries, bounded by the reminder window |

Observations that matter for the design:
- The CalDAV client has no request timeout (`plugins/caldav.ts` uses bare `fetch`). A slow Nextcloud blocks the request for as long as the TCP stack allows.
- `createEvent` sends `If-None-Match: *` (`plugins/caldav.ts:30-37`) and throws on any non-2xx, so a PUT whose response was lost and that is retried gets 412 and fails forever. Any retrying design must treat this explicitly.
- Cancel decides whether to delete the calendar event from `bookings.gcal_event_id`, which is only set AFTER the PUT returns. A cancel that races a slow create therefore skips the DELETE and leaves an orphan event. Today that window is the whole request duration; with a queue it becomes seconds-to-minutes, so ordering must be designed (section 5.6).
- The event UID is deterministic: the booking id (URL `<CALDAV_URL>/<bookingId>.ics`, `UID:<bookingId>@vanjex.dev`). The calendar-sync reader skips events with that UID suffix so a class never blocks itself (`calendar-sync/ics.ts:10`). This coupling must survive the CalendarProvider port.
- Owner-reported: a single booking took 6.7 s end to end. Not measured by me. With 50 occurrences the sequential PUT loop in #4 scales linearly, which explains the browser/tunnel timeouts (the UI shows an error although the booking committed).
- `schedule.routes.ts` already returns 201 for `/schedule/book` and `/schedule/series`, but only after side effects finish.

### 2.5 CalDAV / Nextcloud

- Write side: `plugins/caldav.ts`, decorated as `fastify.caldav` with `createEvent(uid, ical)` / `deleteEvent(uid)`, configured from the global env vars `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD` (required in `config/env.ts`). Called directly from `schedule.service.ts`, `series.service.ts`, `admin.service.ts`, `portfolio.service.ts` (4 modules, 8 call sites).
- Read side: `modules/calendar-sync/*` does a CalDAV REPORT every 5 minutes, parses ICS, mirrors busy time into `blocked_slots` rows with `source = 'caldav'` for `MENTORING_TEACHER_ID`. It reads its config lazily from `process.env` (not from the frozen `config/env.ts`) so tests can point it at a fake server (`calendar-sync/config.ts` header comment). Sync run status is in-memory per process (`calendar-sync.service.ts lastRun`).
- Flag convention (reused in Phase 1): `calendarSyncEnabled(vars)` = false under `NODE_ENV=test`, otherwise on unless `CALDAV_SYNC_ENABLED=false`; the `pnpm dev` script forces the flags to false (`package.json` scripts `dev`, `dev:once`). `remindersEnabled` and `paymentVerificationEnabled` are the same shape.
- Existing manual-run endpoints follow a pattern: `POST /admin/reminders/run`, `POST /admin/calendar-sync/run` (`admin.routes.ts:191,501`). Phase 1 reuses it.

### 2.6 Payments, products, entitlements

- Orders/payment attempts/events live in the `payments` schema, backed by the frozen package `hexagonal-payments-core` pinned to git tag `v0.1.2` (private GitHub dependency, `package.json`; the `Dockerfile` needs a `GH_TOKEN` build arg to install it). Providers: ePayco, PayPal, manual transfer (`adapters/payments/*`). Order kinds are registered in `OrderKindRegistry`; only one kind exists, `class_credit_plan` (`modules/payments/kind-registry.ts`).
- Fulfillment is hardwired to credits: `applySettlementSideEffects` only grants when `metadata.productId && metadata.creditsCount` (`payments.service.ts:~516`).
- Products are synced from WordPress (`lib/wp.ts`, `modules/products/products.service.ts`; WP post type `nodus_product`, webhook `POST /webhooks/wp` guarded by `X-Webhook-Secret`, manual `POST /admin/products/sync`). `mapWpItem` SKIPS any WP product whose metadata lacks a positive integer `creditsCount` (`lib/wp.ts mapWpItem`). A course (no credits) cannot enter the catalog today.
- Entitlements: `ecommerce.content_access` (user, content_type, external_id, reason order|subscription, order_id, valid_from/until, revoked_at; partial unique indexes) with `checkContentAccess` / `grantContentAccess` (`modules/content-access/*`), exposed at `GET /access/check`, `GET /access/my`. Currently written on every credit purchase and read by nothing in the campus that I found (not verified in the campus code).
- `products.metadata.validityDays` drives credit expiry (`resolveGrantExpiry`, `credit-balance.ts`).

### 2.7 Mailer

`plugins/mailer.ts` exposes a nodemailer `Transporter` configured from `SMTP_*` env vars. No templating layer beyond `lib/email-template.ts renderEmailHtml` and per-feature builders (`schedule/student-emails.ts`, `reminders.ts`). Locale is `es | en` per account (`accounts.locale`), with some copy hardcoded in Spanish regardless of locale (admin booking notice, review alert, password reset, cart link).

### 2.8 HTTP contract consistency

Two error envelopes coexist: `{ error: { code, message, details? } }` from `AppError` (`lib/errors.ts`) and `{ error: "text" }` (e.g. `schedule.routes.ts` for `/schedule/book`, `/schedule/my/:id`, reschedule, contact controller). There is no URL versioning and no OpenAPI. CORS origins are an in-code array plus two env vars (`app.ts`). Public connectors will need a stable, documented contract; this is called out in Phase 3 and 6.

### 2.9 What is hardwired to single teacher / CalDAV / env (summary)

| Hardwired thing | Where | Becomes |
|---|---|---|
| One teacher id | `MENTORING_TEACHER_ID` env; `portfolio.service.ts:141`; sync config; seed | per-teacher rows (P3) |
| One calendar | `CALDAV_URL/USERNAME/PASSWORD` env; `fastify.caldav` | `calendar_connections` rows + CalendarProvider (P2/P3) |
| No teacher on bookings | `bookings` schema | `bookings.teacher_id` (P3) |
| Owner identity in copy/recipients | `hola@jesusuzcategui.com` x3, Jitsi host, `@vanjex.dev` UID/PRODID, `America/Bogota`, 24 h cutoff | instance settings in DB (P3/section 7) |
| Boot-time owner seed | `seed-mentoring.ts` | first-run setup (section 7) |
| Credits-only fulfillment | `payments.service.ts`, `lib/wp.ts` | per-kind fulfillers (P5) |
| Binary admin/student UI | campus middleware, nav | role/permission-aware shell (P3) |

---

## 3. Target architecture overview

Principle: hexagonal. The domain modules (scheduling, credits, learning, profiles, catalog, notifications) depend on ports; adapters implement them; infrastructure is wired in one composition root. Durable side effects go through one outbox.

```
                    Public sites / connectors (Astro, WP plugin, Shopify, Drupal/Joomla)
                                      |  HTTPS, API key / SSO token, webhooks out
                                      v
 +-----------------------------------------------------------------------------+
 |                               HUB BACKEND (Fastify)                          |
 |                                                                              |
 |  HTTP layer  --  authn (JWT / API key)  --  authz (permission guard)         |
 |      |                                                                       |
 |  Domain modules                                                              |
 |   scheduling (bookings, series, availability, credits)                       |
 |   teaching   (teachers, skills, profiles)          [P3, P4]                  |
 |   learning   (courses, lessons, progress)          [P5]                      |
 |   catalog    (products <- CatalogSource: WP now)                             |
 |   payments   (orders <- hexagonal-payments-core)                             |
 |   identity   (accounts, roles, sessions)                                     |
 |      |  in the SAME DB transaction as the state change                       |
 |      v                                                                       |
 |  OUTBOX  app.jobs  (Postgres)   <-- enqueue(tx, job)            [P1]         |
 |      |                                                                       |
 |  WORKER (in-process loop, SKIP LOCKED, lease, backoff, dead state) [P1]      |
 |      |  handlers call PORTS, never concrete clients                          |
 |      +--> CalendarProvider  --> CalDAV adapter (P2) | Google, Outlook (P7)   |
 |      +--> Mailer            --> SMTP adapter (nodemailer)                    |
 |      +--> VideoProvider     --> Bunny / Mux / Vimeo / external (P5)          |
 |      +--> WebhookDispatcher --> outbound HTTP, signed (P6)                   |
 |      +--> Analytics (Umami)                                                  |
 +-----------------------------------------------------------------------------+
        |                  |                 |                 |
   Postgres (state     headless WP       Nextcloud/CalDAV   Campus (Nuxt SPA)
   + outbox)           (catalog, CMS)    per teacher        student / teacher / admin
```

Port summary (introduced where noted):

| Port | Today | Adapter(s) | Phase |
|---|---|---|---|
| `JobQueue` (enqueue side) + `JobRunner` (consume side) | none | Postgres outbox; later an outbox-to-BullMQ relay | P1 |
| `CalendarProvider` | `fastify.caldav` + `calendar-sync` | CalDAV; Google; Outlook | P2, P7 |
| `Mailer` | `fastify.mailer` (nodemailer) | SMTP; later API providers | P1 (thin wrapper) |
| `CatalogSource` | `lib/wp.ts` | WordPress; Shopify; manual | P5/P6 |
| `VideoProvider` | none | Bunny, external embed, Mux, Vimeo, self-host | P5 |
| `MeetingLinkProvider` | inline Jitsi URL build | Jitsi; fixed URL template | P3 (config move) |
| payments | `hexagonal-payments-core` | ePayco, PayPal, manual | exists |

Important honesty point on queue swapping: a transactional outbox is only atomic with the business write if it lives in the SAME Postgres. BullMQ/Redis cannot join the booking transaction. So "swap to BullMQ later" means swapping the CONSUMER side (a relay reads `app.jobs` and publishes into BullMQ, workers consume from Redis), while the outbox table remains the durable write path. The `JobQueue.enqueue(db, spec)` interface stays; `JobRunner` is the swappable half.

---

## 4. Phase plan

Sizes: S = a few days, M = 1-2 weeks, L = 3+ weeks, for one engineer or agent with review. Rough, not commitments.

| Phase | Goal | Depends on | Risk | Size |
|---|---|---|---|---|
| P1 | Durable background jobs (outbox + worker); requests answer immediately | none | Medium: touches every after-commit path | M |
| P2 | `CalendarProvider` port, CalDAV as first adapter | P1 (calendar calls run in jobs) | Low | S |
| P3 | Roles + teacher entity + per-teacher calendar connection in DB; remove owner hardcodes | P2 | High: schema change on `bookings`, authz refactor, campus shell change | L |
| P4 | Skills, teacher and student profiles, matching | P3 | Medium (product design more than tech) | M |
| P5 | Pre-recorded courses: catalog, purchase, entitlement, player, progress | P3 (instructor attribution), P1 | Medium-High: payments fulfillment refactor, video provider choice | L |
| P6 | Distribution: public API v1, API keys, webhooks, widgets, WP plugin, Shopify, Drupal/Joomla, licensing | P3 minimum; P5 for course connectors | High surface, low per-connector depth | L (split 6a-6d) |
| P7 | Google / Outlook calendar adapters | P2, P3 | Medium (OAuth, app verification) | M each |

### 4.1 Challenges to the suggested order

I keep P1 -> P2 -> P3 as proposed, with four adjustments:

1. P2 is tiny (S) and should start as soon as P1's calendar handlers exist, ideally inside the same release train. Doing the port before the jobs exist means refactoring call sites twice; doing it after is cheap because the handlers are the only callers left.
2. Add a "contract hygiene" rule from P3 onward rather than a phase: every NEW endpoint uses the `AppError` envelope, the `/v1` prefix and zod-validated, documented schemas; legacy endpoints that the campus/Astro use stay frozen. Otherwise Phase 6 starts with a rewrite of the API.
3. P4 vs P5 ordering is a business call, not a technical one (open decision 7). Technically P5 does not need P4. If a paying course is planned within roughly three months, run P5 before the matching half of P4. A minimal teacher profile (display name, bio, skills list) should land in P3 regardless, because P5 needs "instructor" attribution.
4. Outbound webhooks (P6) come almost free from P1: a `webhook.deliver` job type gets signed delivery, retries and a dead-letter view without new infrastructure. This is the main reason the outbox is worth building first. Licensing/activation and the installer story (no boot-time owner seed, private git dependency removal) are P6 prerequisites and should be scheduled with P3's cleanup of owner hardcodes, not discovered at P6.

### 4.2 Phase scopes and exit criteria

**P1 - Outbox + worker (spec in section 5)**
- Scope: `app.jobs` table, enqueue-in-transaction API, in-process worker, handlers for every after-commit path in 2.4 (#1-#12; #13 reminders stay as they are), admin job visibility/retry endpoints, flags, tests.
- Exit criteria: `POST /schedule/series` with 50 occurrences returns 201 in under 1 s with CalDAV artificially made to take 5 s per call; killing the process after commit and before the worker runs still produces all calendar events and emails after restart; a CalDAV outage of N minutes loses nothing; dead jobs are visible and retryable by an admin; `pnpm test` green; no behavior change in any response body except the documented ones in 5.12.

**P2 - CalendarProvider port**
- Scope: interface (6.1), CalDAV adapter wrapping `plugins/caldav.ts` and the REPORT reader, handlers use the port, calendar-sync uses `listBusy`. Still ONE configured connection from env.
- Exit: no module outside `adapters/calendar/` imports `fastify.caldav` or `fetch`es a calendar URL; a fake provider passes the same contract test suite as the CalDAV adapter; `If-None-Match`/412 behavior and request timeouts live inside the adapter.

**P3 - Roles, teacher entity, per-teacher connection**
- Scope: permission guard replacing the 4 `requireAdmin` copies, `student` alias for `user`, teacher profile table, `bookings.teacher_id`, teacher-scoped availability, `calendar_connections` and `booking_calendar_events` tables, per-teacher sync, campus shell with three roles, instance settings table, removal of `MENTORING_TEACHER_ID`/CalDAV env dependence (kept as a bootstrap fallback for one release), first-run setup instead of the seed.
- Exit: two teachers with separate calendars and availability can be booked concurrently; teacher A cannot read or mutate teacher B's students, bookings, notes or connection (automated cross-teacher test matrix); the owner (admin + teacher) works unchanged; no hardcoded owner email/domain/timezone remains in code paths used by a buyer.

**P4 - Skills and profiles**
- Scope: skill taxonomy, teacher/student profiles, search and matching query, campus screens (6.4).
- Exit: a student completes onboarding with skills/goals; a teacher sees the profile of students who booked with them; `GET /v1/teachers?skill=` returns matches; privacy flags enforced and tested.

**P5 - Courses**
- Scope: catalog source accepts non-credit products, `course_enrollment` order kind with a per-kind fulfiller registry, lessons read-model synced from WP, entitlement via `content_access`, VideoProvider port with one adapter, playback authorization, progress, campus library and player.
- Exit: buy a course through the existing checkout, receive access on settlement (and `needs_review` handling identical to credits), watch with resume, revoke on refund; unauthorized users cannot obtain a playable URL.

**P6 - Distribution** (6a API v1 + API keys + outbound webhooks + OpenAPI; 6b WordPress plugin; 6c Shopify; 6d Drupal/Joomla; plus licensing/activation and white-label)
- Exit per sub-phase in 6.6.

**P7 - Google / Outlook**
- Exit: a teacher connects an account through OAuth, busy time is mirrored, events are created/deleted through the same provider contract test suite.

---

## 5. Phase 1 detailed spec: durable jobs (transactional outbox + worker)

### 5.1 Goals and non-goals

Goals:
- A booking, series, cancellation or payment settlement commits its business state AND its follow-up work atomically. The HTTP request answers right after commit.
- Follow-up work (calendar PUT/DELETE, emails, analytics ping) runs in a worker with retries, backoff, crash recovery, ordering where needed, idempotency, and admin visibility.
- No behavior change for students, except faster responses and the documented response changes in 5.12.

Non-goals (explicit):
- Not moving the reminders cron (`reminders.service.ts`) or payment re-verification into the queue. They already have an atomic claim + bounded retry. They can later enqueue jobs instead of sending inline; not in this phase.
- Not introducing Redis/BullMQ. Not building a dashboard UI in the campus beyond what 5.9 lists as endpoints (a campus screen is a follow-up, S).
- Not fixing the pre-existing non-atomic reschedule (create-new then cancel-old in separate statements) or the non-transactional settlement. Listed as follow-ups in section 9.
- Not changing credit/slot concurrency logic.

### 5.2 Schema

New table in the existing `app` schema (next to `request_logs`, `audit_logs`). Drizzle definition goes in `db/schema/app.ts`; the SQL is a hand-written migration like 0017/0019 (see 5.13).

```sql
-- 0020_jobs_outbox.sql
-- drizzle runs the whole migration in one transaction; do not wrap in BEGIN/COMMIT.
CREATE TABLE "app"."jobs" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq"          bigint GENERATED ALWAYS AS IDENTITY NOT NULL,   -- total order for group ordering
  "type"         text NOT NULL,                                  -- e.g. 'calendar.event.create'
  "payload"      jsonb NOT NULL DEFAULT '{}',                    -- ids and small params, see 5.4
  "status"       text NOT NULL DEFAULT 'pending',                -- pending|running|succeeded|dead|cancelled
  "run_at"       timestamptz NOT NULL DEFAULT now(),             -- not before; backoff moves it
  "expires_at"   timestamptz,                                    -- do not run after; then -> cancelled
  "attempts"     smallint NOT NULL DEFAULT 0,                    -- incremented at claim time
  "max_attempts" smallint NOT NULL DEFAULT 8,
  "group_key"    text,                                           -- serialize jobs with the same key, in seq order
  "dedupe_key"   text,                                           -- idempotent enqueue
  "locked_by"    text,                                           -- worker id (hostname:pid:random)
  "locked_until" timestamptz,                                    -- lease end
  "started_at"   timestamptz,
  "finished_at"  timestamptz,
  "last_error"   text,                                           -- class + short message, never payload/PII
  "last_error_at" timestamptz,
  "request_id"   text,                                           -- correlation with the HTTP request log line
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "jobs_status_check" CHECK ("status" IN ('pending','running','succeeded','dead','cancelled')),
  CONSTRAINT "jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" >= 1),
  CONSTRAINT "jobs_running_lease_check" CHECK ("status" <> 'running' OR ("locked_by" IS NOT NULL AND "locked_until" IS NOT NULL))
);
--> statement-breakpoint
-- claim scan: only live work
CREATE INDEX "idx_jobs_claim" ON "app"."jobs" USING btree ("run_at", "seq") WHERE "status" = 'pending';
--> statement-breakpoint
-- lease reaper
CREATE INDEX "idx_jobs_lease" ON "app"."jobs" USING btree ("locked_until") WHERE "status" = 'running';
--> statement-breakpoint
-- group ordering lookup ("is there an earlier unfinished job in my group?")
CREATE INDEX "idx_jobs_group_live" ON "app"."jobs" USING btree ("group_key", "seq") WHERE "group_key" IS NOT NULL AND "status" IN ('pending','running');
--> statement-breakpoint
-- idempotent enqueue
CREATE UNIQUE INDEX "uq_jobs_dedupe_key" ON "app"."jobs" USING btree ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;
--> statement-breakpoint
-- admin views and retention
CREATE INDEX "idx_jobs_status_updated" ON "app"."jobs" USING btree ("status", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_jobs_type_created" ON "app"."jobs" USING btree ("type", "created_at" DESC);
```

Status semantics:

| Status | Meaning | Transitions out |
|---|---|---|
| `pending` | waiting for `run_at`; also the state after a failed attempt (with `run_at` pushed by backoff) | claim -> `running`; admin cancel -> `cancelled`; expiry -> `cancelled` |
| `running` | claimed, lease held (`locked_until`) | success -> `succeeded`; retriable failure -> `pending`; permanent failure or attempts exhausted -> `dead`; lease expired -> reaper -> `pending` (or `dead` if attempts exhausted) |
| `succeeded` | done; purged after retention | terminal |
| `dead` | will not run again by itself; visible to admin; retry endpoint resets it | admin retry -> `pending` |
| `cancelled` | intentionally not run (admin, expired, or superseded) | terminal |

Notes:
- "Failed" is not a stored status. A failed attempt leaves the row `pending` with `attempts > 0`, `last_error`, and a future `run_at`. This keeps the claim index partial and tiny.
- `seq` is an identity column (not a timestamp) so group ordering is a strict total order even for jobs inserted in the same transaction.
- `last_error` stores the error class and a truncated message (<= 500 chars) with secrets and addresses scrubbed. Follow the existing convention in `reminders.service.ts`: log ids and `errName`, not PII.
- No foreign keys to bookings/orders: the table must accept any entity id, and jobs must outlive deleted entities (handlers treat "entity gone" as a no-op success).

### 5.3 Enqueue-in-transaction API

Location: `src/modules/jobs/` (`queue.ts`, `types.ts`, `worker.ts`, `handlers/*.ts`, `jobs.routes.ts`, `backoff.ts`). Drizzle schema in `db/schema/app.ts`.

```ts
// types.ts
export type JobType = keyof JobPayloads;             // closed union, see 5.4
export interface EnqueueSpec<T extends JobType = JobType> {
  type: T;
  payload: JobPayloads[T];
  runAt?: Date;                                      // default now
  expiresAt?: Date;                                  // skip if too late to matter
  groupKey?: string;                                 // serialize by entity, e.g. `booking:<id>`
  dedupeKey?: string;                                // idempotent enqueue
  maxAttempts?: number;                              // default from registry
}

// queue.ts  (consumer-agnostic write side)
export interface JobQueue {
  /** `db` is a transaction handle OR the pool. Inside a transaction the job commits/rolls back with it. */
  enqueue(db: DbHandle, specs: EnqueueSpec | EnqueueSpec[]): Promise<{ id: string; deduped: boolean }[]>;
  /** Cancels pending jobs by dedupe key; used to net out create+delete of a never-run event (5.6). */
  cancelPending(db: DbHandle, dedupeKeys: string[], reason: string): Promise<number>;
}
```

- `DbHandle` is the type already exported from `modules/schedule/schedule.service.ts` (`PgDatabase<NodePgQueryResultHKT, typeof schema>`), so a `tx` from `fastify.drizzle.transaction(...)` and the pool both fit. `series.service.ts` already casts the transaction handle with `rawTx as unknown as DbHandle`; reuse that.
- Implementation `PgJobQueue` does ONE multi-row `INSERT ... ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id` per call, so a 50-occurrence series adds one statement to the transaction, not 100. Whether drizzle's `onConflictDoNothing({ target, where })` accepts the partial-index predicate in 0.45 is NOT verified; fall back to raw `tx.execute(sql\`...\`)` if not.
- `request_id` is taken from the Fastify request id when available (`req.id`), else null.
- Enqueue never calls any provider and never throws for business reasons. If it throws, the surrounding transaction rolls back and the request fails honestly (the booking did not happen).

Call-site shape (createStudentBooking), replacing the after-commit block:

```ts
await fastify.drizzle.transaction(async (tx) => {
  // ... existing checks, credit charge, insertBookingInTx ...
  await jobQueue.enqueue(tx, bookingCreatedJobs({ bookingId, startsAt, endsAt }));
});
return { bookingId, meetLink, startsAt };   // immediately
```

### 5.4 Job types and payloads

Naming: `<domain>.<subject>.<action>`. Payloads carry ids and small parameters only. Handlers load fresh state at run time so a cancelled/rescheduled/renamed entity is handled correctly and content is never stale. Exceptions (public forms with no entity row) carry the minimum content and are redacted on success (5.14).

Group key = serialization scope. Dedupe key = idempotency scope. `expires` = `expires_at`. Defaults: `max_attempts` 8 unless stated.

| Type | Payload | Group | Dedupe key | Expires | Replaces (2.4 #) |
|---|---|---|---|---|---|
| `calendar.event.create` | `{ subject: { kind: "booking" \| "mentoring_request", id } }` | `cal:<kind>:<id>` | `cal.create:<kind>:<id>` | class end | 1, 3, 4, 10 |
| `calendar.event.delete` | `{ subject: { kind, id } }` (UID = id, deterministic) | `cal:<kind>:<id>` | `cal.delete:<kind>:<id>` | none | 2, 3, 5, 6 |
| `email.booking_confirmed` | `{ bookingId }` (student email + `.ics` REQUEST) | `mail:booking:<id>` | `mail.booking_confirmed:<id>` | class start | 1 |
| `email.booking_admin_notice` | `{ bookingId }` | none | `mail.booking_admin_notice:<id>` | class start | 1 (3 via 1) |
| `email.booking_cancelled` | `{ bookingId }` | none | `mail.booking_cancelled:<id>` | none | 6 |
| `email.series_confirmed` | `{ seriesId, bookingIds[], creditsUsed, balanceAfter }` | none | `mail.series_confirmed:<seriesId>` | none | 4 |
| `email.series_cancelled` | `{ seriesId, cancelledBookingIds[], keptBookingIds[], creditsRefunded }` | none | `mail.series_cancelled:<seriesId>:<epoch-of-cancel-tx>` | none | 5 |
| `email.weekly_slot_changed` | `{ bookingId }` (one job per affected booking) | none | `mail.weekly_slot_changed:<bookingId>:<slotId>` | class start | 7 |
| `email.cart_link` | `{ cartId }` | none | none (a resend is intentional) | none | 8 |
| `email.payment_confirmed` | `{ orderId }` (handler creates the set-password token at run time) | none | `mail.payment_confirmed:<orderId>` | none | 9 |
| `email.order_needs_review_admin` | `{ orderId, reason }` | none | `mail.order_review:<orderId>:<reason>` | none | 9 |
| `email.mentoring_request_admin` | `{ requestId, locale }` | none | `mail.mentoring_admin:<requestId>` | none | 10 |
| `email.mentoring_request_client` | `{ requestId, locale }` | none | `mail.mentoring_client:<requestId>` | none | 10 |
| `email.contact_form` | `{ name, email, message, projectType, budget }` (no entity row exists) | none | none | none | 11 |
| `auth.password_reset_requested` | `{ email }` (always enqueued, even for unknown email; handler decides) | none | none | 1 h | 12 |
| `analytics.purchase_event` | `{ orderId }` | none | `analytics.purchase:<orderId>` | none; `max_attempts` 3 | 9 |

Design notes per row group:
- Calendar jobs use the booking id as the calendar UID (already the case), so DELETE does not depend on `bookings.gcal_event_id`. The enqueue sites no longer branch on `gcalEventId`; they always enqueue the delete and the handler is idempotent (404 = success). This removes the orphan-event race in 2.4.
- `calendar.event.create` for `kind = "booking"`: the handler sets `bookings.gcal_event_id = id` on success (keeps the existing meaning of the column and the campus field `gcalEventId` returned by `listStudentBookings`). In P2/P3 this moves to `booking_calendar_events`.
- `auth.password_reset_requested`: always enqueued after an email-shaped input, so the HTTP path does identical work for known and unknown addresses (kills the timing channel of 2.4 #12; the lookup and token insert move into the handler). The raw reset token is generated inside the handler and never stored in the payload or the jobs table. A retry may mint a second token; the first stays valid until its 1 h TTL, which is acceptable.
- `email.payment_confirmed`: same principle, the set-password token is created at run time. The `password_reset_tokens` insert moves out of the settlement path.
- `email.series_confirmed` carries `balanceAfter` because it is a value computed inside the transaction that is expensive/unsafe to recompute later; every other value is loaded.
- `email.series_cancelled` dedupe key includes a per-transaction discriminator because one series can legitimately be cancelled in parts over time (student cannot cancel within 24 h; admin cancels the rest later).
- `email.weekly_slot_changed`: replaces a sequential loop that holds the HTTP request for N SMTP sends (2.4 #7).
- Coupon redemption increment and credit grants are DB operations, not provider calls; they stay inline in settlement for P1 (flagged in section 9 as "make settlement one transaction").

Handler registry:

```ts
export interface JobHandler<T extends JobType> {
  type: T;
  maxAttempts?: number;                 // default 8
  timeoutMs?: number;                   // default JOBS_HANDLER_TIMEOUT_MS
  run(ctx: JobContext, payload: JobPayloads[T]): Promise<void>;   // throw = failure
}
export interface JobContext {
  job: { id: string; attempt: number; maxAttempts: number; createdAt: Date };
  db: DbHandle;                         // pool, not a transaction
  signal: AbortSignal;                  // aborted at timeoutMs or shutdown grace end
  log: FastifyBaseLogger;               // child logger with jobId/type/attempt
  calendar: CalendarGateway;            // P1: thin wrapper over fastify.caldav; P2: the port
  mailer: Mailer;                       // wrapper that sets Message-ID from job id
}
export class PermanentJobError extends Error {}   // never retry -> dead
export class SkipJob extends Error {}             // precondition no longer true -> succeed as no-op
```

Handler rules:
- First step is always "load current state; if the entity is gone, cancelled, or past its relevance, return (no-op success)". Examples: create-event on a booking with `status = 'cancelled'` returns without PUT; booking emails skip if the booking is cancelled (except `email.booking_cancelled`); reminders-like staleness is covered by `expires_at` too.
- Handlers must be safe to run twice. Calendar: the PUT is overwrite-idempotent (deterministic UID and content). Email: at-least-once; see 5.7.
- Handlers take their own `AbortSignal` for the provider call. The CalDAV adapter must pass `signal` to `fetch` (today there is no timeout at all).

### 5.5 Worker loop

Runs in the API process as a Fastify plugin (`plugins/jobs.ts`), same shape as `plugins/reminders.ts`: registered in `app.ts`, `dependencies: ["postgres", "mailer", "caldav"]`, started in an `onReady` hook, stopped in `onClose`. Because the claim is pure SQL, extracting it into a separate `worker.ts` entry point later requires no design change.

Parameters (read lazily from `process.env` in `modules/jobs/config.ts`, the same reason as `calendar-sync/config.ts`: tests must be able to override without re-importing the frozen `config/env.ts`):

| Env | Default | Meaning |
|---|---|---|
| `JOBS_ENABLED` | true (see 5.10) | master switch for the worker loop (enqueue always works) |
| `JOBS_POLL_MS` | 1000 | idle poll interval |
| `JOBS_BATCH_SIZE` | 10 | max rows claimed per statement |
| `JOBS_CONCURRENCY` | 4 | max handlers in flight |
| `JOBS_LEASE_MS` | 120000 | lease length; must exceed handler timeout |
| `JOBS_HANDLER_TIMEOUT_MS` | 30000 | per-handler abort |
| `JOBS_SHUTDOWN_GRACE_MS` | 8000 | wait for in-flight jobs on shutdown |
| `JOBS_RETENTION_DAYS` | 14 | succeeded/cancelled retention; dead kept 90 days |
| `DB_POOL_MAX` | (new) 20 | raises `pg` pool size so worker + HTTP do not starve each other |

Loop (per process):

```
tick:
  if stopping: return
  free = CONCURRENCY - inflight
  if free == 0: wait for a slot or POLL_MS
  rows = claim(min(BATCH_SIZE, free))            -- one short autocommit statement, 5.5.1
  for each row: inflight++; run(row) (not awaited here)
  if rows.length == batch: tick again immediately  -- backlog, do not sleep
  else: sleep(POLL_MS)
every 30 s: reap()                               -- 5.5.3
every day 03:30 UTC (node-cron, like autoPurge): purge() -- 5.5.5
```

Cadence rationale: a 1 s poll over a partial index that only contains runnable rows is negligible load and bounds enqueue-to-start latency at about 1 s. `LISTEN/NOTIFY` could cut that to near zero but needs a dedicated connection and reconnect logic; deferred (section 9).

Concurrency rationale: 4 handlers with `DB_POOL_MAX` 20 leaves room for HTTP. Provider-specific throttling (e.g. 1-2 concurrent CalDAV PUTs per Nextcloud) belongs in the P2 adapter, not here. Group ordering already serializes work per booking.

#### 5.5.1 Claim

```sql
WITH due AS (
  SELECT j.id
  FROM app.jobs j
  WHERE j.status = 'pending'
    AND j.run_at <= now()
    AND NOT EXISTS (                    -- an earlier unfinished job in the same group blocks this one
      SELECT 1 FROM app.jobs e
      WHERE e.group_key = j.group_key   -- NULL = NULL is false: ungrouped jobs never block
        AND e.seq < j.seq
        AND e.status IN ('pending', 'running'))
  ORDER BY j.run_at, j.seq
  LIMIT $1
  FOR UPDATE OF j SKIP LOCKED
)
UPDATE app.jobs j
SET status = 'running', attempts = j.attempts + 1, locked_by = $2,
    locked_until = now() + ($3 * interval '1 millisecond'),
    started_at = now(), updated_at = now()
FROM due WHERE j.id = due.id
RETURNING j.*;
```

- This is the same idea as the reminders claim (`UPDATE ... WHERE flag IS NULL RETURNING id`, only the caller whose UPDATE returns the row may proceed) generalized to batches with `FOR UPDATE SKIP LOCKED`: two workers (or two instances of the API) never receive the same row.
- `attempts` is incremented AT CLAIM, so a job that crashes the process every time cannot loop forever (poison-pill protection): after `max_attempts` claims it goes dead even if no handler ever returned.
- Group ordering inside one statement: a group's later jobs are excluded because their earlier siblings are still `pending` in the statement's snapshot, so at most the head of each group is claimed per call. A permanently `dead` or `cancelled` earlier job does NOT block (only `pending`/`running` do), so a dead create never wedges the cancel that follows it. A `pending` create waiting on backoff DOES block its delete; that is the intended ordering.
- Drizzle can express `FOR UPDATE ... SKIP LOCKED` on selects (`.for("update", { skipLocked: true })`, not verified for 0.45), but the NOT EXISTS + UPDATE...FROM combination is cleaner as one raw statement via `db.execute(sql...)`.
- Expired jobs: before running, the worker checks `expires_at < now()` and marks the row `cancelled` with `last_error = 'expired'` (no handler call).

#### 5.5.2 Completion and failure (fenced)

All completion writes are conditional on still owning the lease, mirroring the "clear the claim only if it is still ours" pattern in `reminders.service.ts`:

```sql
-- success
UPDATE app.jobs SET status='succeeded', finished_at=now(), locked_by=NULL, locked_until=NULL, updated_at=now()
WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts=$3;
-- retriable failure
UPDATE app.jobs SET status='pending', run_at=$4, last_error=$5, last_error_at=now(),
       locked_by=NULL, locked_until=NULL, updated_at=now()
WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts=$3;
-- permanent failure or attempts exhausted
UPDATE app.jobs SET status='dead', finished_at=now(), last_error=$5, last_error_at=now(), ... (same guard)
```

If the guarded UPDATE affects 0 rows, the lease was lost (reaped and possibly re-claimed) and the late result is discarded with a `warn` log. Idempotent handlers make the possible double execution harmless.

#### 5.5.3 Lease, visibility timeout and crash recovery

- Lease length defaults to 120 s, handler timeout to 30 s. No heartbeat in P1; if a future handler legitimately needs longer, give it a larger `timeoutMs` and have the worker set `locked_until = now() + timeoutMs + margin` at claim time (per-type lease), rather than adding heartbeats.
- Reaper (every 30 s and once at startup):

```sql
UPDATE app.jobs
SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
    run_at = now(), locked_by = NULL, locked_until = NULL,
    last_error = 'lease expired (worker crashed or timed out)', last_error_at = now(), updated_at = now()
WHERE status = 'running' AND locked_until < now()
RETURNING id, type, attempts, status;
```
- Result: kill -9 the API mid-job and within at most lease + 30 s another tick (or the restarted process) picks the job up again. Crash during a PUT is safe because the PUT is idempotent; crash after SMTP accepted but before the success UPDATE yields at most one duplicate email (5.7).
- Startup does not reap immediately blind: it reaps only rows whose lease already expired, so a rolling deploy with two instances never steals live work.

#### 5.5.4 Retry, backoff and dead letter

Backoff after attempt `n` (n = value of `attempts` after the claim): `delay = min(30 s * 4^(n-1), 6 h)`, then +/-20% jitter (injectable RNG for tests).

| After attempt | Base delay | Cumulative (approx) |
|---|---|---|
| 1 | 30 s | 30 s |
| 2 | 2 min | 2.5 min |
| 3 | 8 min | 10.5 min |
| 4 | 32 min | 43 min |
| 5 | 2 h 8 min | 2 h 50 min |
| 6 | 6 h (cap) | ~9 h |
| 7 | 6 h | ~15 h |
| 8 | -> dead | |

So default `max_attempts = 8` tolerates roughly a 15-hour provider outage. Per-type overrides: `analytics.purchase_event` 3; `auth.password_reset_requested` 5 (expires at 1 h anyway); everything else 8.

Error classification (in `classifyError`, pure and unit-tested):
- Success (not an error): CalDAV 412 on create (the event already exists), 404/204 on delete.
- Retriable: network errors, timeouts/aborts, HTTP 5xx, 408, 423, 429, SMTP 4xx / connection errors.
- Permanent (`PermanentJobError`, straight to `dead`): HTTP 400, 404 on create, 409, 410, 415, 422; SMTP 5xx recipient/envelope rejections (invalid address); malformed payload (zod parse failure); unknown job type.
- 401/403 from a provider are retriable with the normal backoff (a credential problem can be fixed within the ~15 h window by the admin) but are surfaced distinctly in `stats` as `authFailures`.
- Dead letter = `status = 'dead'`: it stays in the table with `last_error`, is returned by the admin list, counted in stats, and can be retried (5.9). Optional (default off): when a job becomes dead, send ONE throttled direct SMTP alert to the admin inbox (not a job, to avoid loops), reusing `env.campus.adminNotificationEmail` semantics; throttle in memory to 1 per hour.

#### 5.5.5 Retention

Daily 03:30 UTC (node-cron, the `autoPurge` pattern): delete `succeeded` and `cancelled` older than `JOBS_RETENTION_DAYS` (default 14), `dead` older than 90 days, in batches of 1000 to keep locks short. Dedupe keys are released with the row, so a very late re-enqueue after retention would run again; acceptable because enqueue sites are transaction-bound to fresh business events.

### 5.6 Ordering requirements

| Need | Mechanism |
|---|---|
| Delete must not run before the create of the same event (cancel right after book) | same `group_key = cal:<kind>:<id>`; claim blocks the later `seq` until the earlier is `succeeded`/`dead`/`cancelled` |
| Create after the booking was already cancelled | create handler loads the booking, sees `cancelled`, no-ops (defense in depth beyond grouping) |
| Cancel enqueued while the create never started | optional optimization in the cancel transaction: `cancelPending(['cal.create:booking:<id>', 'mail.booking_confirmed:<id>', 'mail.booking_admin_notice:<id>'])` then still enqueue the delete only if the create had `attempts > 0`; net effect: a booking cancelled within a second causes no calendar traffic and no "confirmed" email. Recommended, small. |
| Confirmation email vs cancellation email for the same booking | `mail:booking:<id>` group on confirmed; cancellation handler also no-ops confirmed if cancelled |
| Reschedule: new-event create vs old-event delete | independent bookings, independent groups; no ordering needed |
| Series: N creates | N independent jobs, each with its own group and retry; one failing PUT does not stall the others |

### 5.7 Idempotency

Layers:
1. Enqueue idempotency: `dedupe_key` unique partial index; `ON CONFLICT DO NOTHING`. Double-submits and retried transactions cannot create duplicate jobs.
2. Handler idempotency toward the provider:
   - Calendar create: deterministic UID and body; use PUT that overwrites. Change from today: drop `If-None-Match: *` in the adapter or treat 412 as success. Decision: treat 412 as success AND keep the header, to preserve the "do not clobber a foreign event with the same UID" guard at zero cost. Calendar delete: 404/204 are success (already so).
   - Email: SMTP is at-least-once by nature. The wrapper sets `Message-ID: <job-<id>@<from-domain>>` so a duplicate delivery carries the same Message-ID (many clients and gateways collapse it). Success UPDATE immediately follows the SMTP acceptance. Duplicate window = crash between those two statements; accepted and documented.
3. Business idempotency: handlers re-read state, so late/duplicate runs after a cancel are no-ops.

### 5.8 Graceful shutdown

Today nothing wires signals to `app.close()` (verified, 2.1). Required change in `server.ts` (small): register `SIGTERM` and `SIGINT` handlers that call `app.close()` once.

On close (`onClose` hook of the jobs plugin):
1. Set `stopping = true`: no new claims.
2. Await in-flight handlers up to `JOBS_SHUTDOWN_GRACE_MS`. Containers stop with a default 10 s grace in Docker; keep this at 8 s, or set `stop_grace_period` in compose/Coolify and raise it.
3. Past the grace period, abort remaining handlers via their `AbortSignal` and release their leases: `UPDATE ... SET status='pending', run_at=now(), locked_by=NULL, locked_until=NULL, attempts = attempts - 1 WHERE locked_by=$me AND status='running'` (a shutdown abort must not burn an attempt). If the process is killed before that, the reaper recovers the rows after the lease expires.
4. Then the pool closes (existing postgres plugin hook). Plugin registration order must keep the jobs plugin's `onClose` running before the pool's: Fastify/avvio is expected to run `onClose` hooks in reverse registration order (not verified; add a test that asserts the worker stops before the pool ends). `jobs` depends on `postgres`, so it registers after it and should close first.

### 5.9 Admin visibility and retry

New routes in `modules/jobs/jobs.routes.ts`, guarded by the admin check (use the existing `requireAdmin` copy in P1; replaced by the permission guard in P3). Payloads are never returned in list responses; the detail view masks email addresses with the existing `maskEmail` helper (`schedule/reminders.ts:96`).

| Method and path | Purpose |
|---|---|
| `GET /admin/jobs?status=&type=&limit=&cursor=` | paged list (id, type, status, attempts/maxAttempts, run_at, last_error, last_error_at, created_at, finished_at) ordered by `seq desc` |
| `GET /admin/jobs/stats` | counts by status and type; oldest pending age (queue lag); dead count; counters of `authFailures` since boot; last purge; worker enabled flag, concurrency, worker id |
| `GET /admin/jobs/:id` | detail incl. masked payload |
| `POST /admin/jobs/:id/retry` | only `dead` or `cancelled(expired)`: sets `status='pending', attempts=0, run_at=now(), last_error=NULL`. Re-enqueueing a stale dedupe key is not needed because the same row is reused |
| `POST /admin/jobs/:id/cancel` | only `pending` -> `cancelled` |
| `POST /admin/jobs/run` `{ limit?: number }` | one manual drain pass in the request (same pattern as `POST /admin/reminders/run`, `POST /admin/calendar-sync/run`); the only way jobs run when the worker is disabled in local dev |

Retry/cancel write an `app.audit_logs` row (`action = 'job.retry'|'job.cancel'`, `actor_id`, `target_id`, `target_type = 'job'`). This is the first writer of that currently unused table; it is already in the schema, so no migration.

### 5.10 Config flags (existing pattern)

`modules/jobs/config.ts`:

```ts
export function jobsEnabled(vars: { NODE_ENV?: string; JOBS_ENABLED?: string }): boolean {
  if (vars.NODE_ENV === "test") return false;                       // a test boot can never email anybody
  return (vars.JOBS_ENABLED ?? "true").toLowerCase() !== "false";   // on by default in prod image (no NODE_ENV set)
}
```

- Identical shape to `remindersEnabled`, `paymentVerificationEnabled`, `calendarSyncEnabled`.
- `package.json` `dev` and `dev:once` get `JOBS_ENABLED=${JOBS_ENABLED:-false}` like the other three flags (a laptop with real SMTP/CalDAV credentials must not fire real side effects by accident).
- Consequence to be aware of: today `pnpm dev` DOES send inline booking emails and calendar PUTs (the three existing flags only cover the crons). With the worker off in dev, local bookings enqueue rows that nothing drains until `POST /admin/jobs/run` or `JOBS_ENABLED=true pnpm dev`. This is deliberate and consistent, but it is a dev-experience change (open decision 11).
- Enqueue is never gated by the flag, so tests always observe enqueued rows and the production data path is the one under test.
- Under `NODE_ENV=test` the worker is off; integration tests drive the worker explicitly through exported `runJobsOnce(deps, options)` (`options.now`, `options.handlers`, `options.rng`) so time and providers are injected, like `runReminderPass(fastify, { now })`.

### 5.11 How existing inline code migrates without changing behavior

Principle: MOVE the code, do not rewrite it. For each call site:
1. Extract the body of the inline try/catch into a handler function with the same logic (e.g. `sendBookingConfirmation(ctx, bookingId)` containing the existing `buildBookingConfirmedEmail` + `.ics` attachment code; `notifyAdminsOfBooking` body unchanged).
2. Replace the inline block with `enqueue(tx, ...)` inside the existing transaction (for #1/#4/#5/#6 the transaction already exists; for #2/#3/#7/#8-#12 wrap the state change and the enqueue in a short transaction).
3. Keep email builders, ICS builder, and subjects as they are (including the Spanish admin subject; localization is P3/section 7, not here).
4. Pure builders keep their unit tests (`student-emails.test.ts`, etc.).

Call-site checklist (each is one commit/PR-sized step, in rollout order of 5.15):

| # | Change |
|---|---|
| 1 `createStudentBooking` | in the tx: enqueue `calendar.event.create`, `email.booking_confirmed`, `email.booking_admin_notice`; delete the product-name query and inline sends after the tx (handlers load product and student). Return value unchanged |
| 4 `createSeries` | in the tx: one multi-row enqueue of N `calendar.event.create` + 1 `email.series_confirmed` (`bookingIds`, `creditsUsed`, `balanceAfter`). Remove the sequential loop and the `inArray(products...)` after-commit query. NO admin notice is added (preserves current behavior; flagged as a possible product gap in 5.16) |
| 5 `cancelSeries` | in the tx after the refunds: enqueue N `calendar.event.delete` (always, no `gcalEventId` branch) + `email.series_cancelled` (only if `cancelled.length > 0`, as today) |
| 2 `cancelStudentBooking` | wrap the existing update statements plus enqueue `calendar.event.delete` in the existing transaction (already a tx) |
| 6 admin `cancelBooking` | same, plus `email.booking_cancelled` |
| 3 reschedule | new booking via #1 (enqueues its own jobs); after the existing conditional cancel of the old one succeeds, enqueue `calendar.event.delete` for the old booking id in a short tx together with the availability release. The non-atomic structure stays as is |
| 7 `deactivateWeeklySlot` | same transaction as the slot update: enqueue one `email.weekly_slot_changed` per affected booking; `notifiedBookings` now means "queued" |
| 8 cart link / checkout link | enqueue `email.cart_link` after the cart row exists (a short tx or the same one) |
| 9 settlement | enqueue `email.payment_confirmed`, `analytics.purchase_event`, and, where flagged, `email.order_needs_review_admin` instead of inline; credit grant, content access, fulfillment flip and coupon increment stay inline in P1 |
| 10 mentoring request | in the existing tx after the insert: enqueue `calendar.event.create (mentoring_request)`, `email.mentoring_request_admin`, `email.mentoring_request_client`. `locale` goes in the payload (not stored on the row today) |
| 11 contact | enqueue `email.contact_form`; controller returns `{ ok: true }` after enqueue |
| 12 password reset | enqueue `auth.password_reset_requested { email }` and return; the lookup/token/email move into the handler |

Handlers wrap the provider calls through two thin gateways that exist only in P1 and are replaced by the P2 port: `CalendarGateway` (delegates to `fastify.caldav`, adds the timeout/`signal`, treats 412 on create as success) and `Mailer` (delegates to `fastify.mailer`, adds `Message-ID`). This keeps P1 small and makes P2 a pure substitution.

### 5.12 HTTP responses after Phase 1

| Endpoint | Before | After |
|---|---|---|
| `POST /schedule/book` | 201 after CalDAV + 2 emails | 201 right after commit; same body `{ data: { bookingId, meetLink, startsAt } }` |
| `POST /schedule/series`, `POST /admin/students/:id/series` | 201 after N sequential PUTs + email | 201 right after commit; same body |
| `DELETE /schedule/my/:id`, `PATCH .../reschedule`, series cancel, admin cancel | wait for CalDAV (+ email) | return after commit; same bodies |
| `PATCH /admin/weekly-slots/:id` (deactivate) | `notifiedBookings` = emails actually sent | same field, value = emails queued (documented semantic change) |
| `POST /contact` | 500 when SMTP fails | 200 `{ ok: true }` once queued; delivery failures become visible dead jobs. Intentional improvement; user-visible behavior change |
| `POST /auth/forgot-password` | different timing for unknown email | same status/body; timing no longer depends on account existence |
| public mentoring request | returns after PUT + 2 emails | returns `{ id, startsAt }` right after commit |

New client-visible fact: side effects are eventually consistent (typically < 2 s). The campus must not assume `gcalEventId` is set in the 201 response. The campus code I read does not appear to depend on it (not exhaustively verified).

### 5.13 Migration numbering and journal

- File: `drizzle/migrations/0020_jobs_outbox.sql` (hand-written SQL, no `-- statement-breakpoint` omissions: every statement separated with `--> statement-breakpoint`, same as 0017/0019).
- Journal entry to append to `drizzle/migrations/meta/_journal.json`:

```json
{ "idx": 20, "version": "7", "when": 1791676800000, "tag": "0020_jobs_outbox", "breakpoints": true }
```

  `1791676800000` = previous `when` (1791590400000, idx 19) + 86,400,000. The drizzle migrator applies only migrations whose `when` is greater than the last applied one, so the value MUST be strictly greater than 1791590400000; reuse the one-day increment convention seen on every prior entry.
- Add a drizzle table definition for `app.jobs` to `db/schema/app.ts` (keep schema and SQL in sync; the repo has only a 0000 snapshot, so no `drizzle-kit generate` output is needed or trusted).
- Add `db/__tests__/migration-0020.test.ts` following `migration-0017.test.ts`/`0019` (look the migration up by tag so later migrations do not break it).
- No data backfill. Additive only. `repairSchema` in `db/migrate.ts` is NOT extended.

### 5.14 Security and data handling

- `payload` carries ids; the only raw content is `email.contact_form` and `auth.password_reset_requested` (an email address). On `succeeded`, a handler-completion step replaces those payloads with `{"redacted":true}` (a boolean on the type registry, `redactOnSuccess`). Dead jobs keep payload until purge (90 days) so an admin can retry; the detail endpoint masks addresses.
- `last_error` is built from an allow-list (error class, HTTP status, SMTP response code); never provider response bodies, credentials, URLs with credentials, event titles or message content. This follows the explicit rule in `calendar-sync` ("no response body, credentials, URLs or event titles in logs").
- Admin endpoints require the admin gate; no student or teacher access in P1.

### 5.15 Rollout and rollback

Rollout (each step independently deployable and revertible):
1. Ship migration 0020 + queue + worker + handlers + admin endpoints with worker ON in prod but ONLY the series create/cancel and single booking/cancel call sites switched (#1, #2, #4, #5, #6). These are the fragile ones. Verify on staging with the fake-latency test (exit criteria) and then in prod with one real series.
2. Switch #3, #7, #8, #12, #11.
3. Switch #9 (settlement) and #10 (public mentoring request). Settlement is the most sensitive: do it last, with a staging order paid through ePayco sandbox/manual transfer.
4. Add the `server.ts` signal handlers together with step 1 (needed for clean worker shutdown).

Observe between steps: `GET /admin/jobs/stats` shows dead = 0 and queue lag < 5 s.

Rollback:
- Code: redeploy the previous image. The table is additive and ignored by old code, so no schema rollback is required.
- Jobs enqueued by the new version stay `pending`. On roll-forward they drain (with `expires_at` skipping stale class emails). If you prefer not to execute them: `UPDATE app.jobs SET status='cancelled', last_error='rolled back' WHERE status='pending' AND type LIKE 'email.%'` (note: this is a manual SQL step for you to run deliberately; I am not running anything).
- Kill switch without redeploy: `JOBS_ENABLED=false` stops processing while keeping enqueue; `POST /admin/jobs/run` drains manually.
- No dual code path (inline vs queue) is maintained in the repo; a dual path would double the bug surface. The rollback lever is the image, not a flag.

### 5.16 Test plan

Strict TDD applies (project setting): pure units first (red/green), then integration. DB tests follow the repo's throwaway-database guard (`lib/test-db-guard.ts`: name ends `_it|_test|_rem|_ser`): env `JOBS_IT_DATABASE_URL` pointing to a DB ending in `_it`; `describe.skipIf(!DB_URL)` like `series.integration.test.ts`; providers are always fakes (no real SMTP/CalDAV call).

Unit (no DB):
- `backoff.test.ts`: schedule table in 5.5.4, cap, jitter bounds with injected RNG.
- `classifyError.test.ts`: every row of the classification list (HTTP codes, SMTP codes, abort, 412-on-create-is-success).
- `jobsEnabled.test.ts`: same three assertions as `remindersEnabled` (default on, `false` disables, `NODE_ENV=test` always off).
- Payload zod schemas and the registry (unknown type -> permanent).

Integration (throwaway DB, fake provider + fake mailer with controllable latency/failures):
1. Atomicity: enqueue inside a transaction that rolls back leaves no job; one that commits leaves exactly the expected jobs (booking + jobs both exist or neither).
2. Dedupe: enqueue the same `dedupe_key` twice returns `deduped: true` once and one row.
3. Double-claim: insert 200 jobs, run 8 concurrent claimers (separate connections) in a loop until drained; assert every job was claimed exactly once (set of ids equals, no duplicates) and `attempts = 1` for all.
4. Crash recovery: claim a job, never complete it, advance injected time past `locked_until`, run the reaper: job is `pending` again, `attempts` preserved; repeat until `max_attempts`: ends `dead`. Also: a late completion from the "crashed" worker is rejected by the fence (0 rows) and does not overwrite the new owner's result.
5. Group ordering: create+delete of one booking: the delete is not claimable while the create is `pending` or `running`; after the create succeeds the delete runs; if the create goes `dead` the delete becomes claimable; a pending create in backoff still blocks the delete.
6. Retry/backoff end to end: fake provider fails twice then succeeds; assert `run_at` follows the schedule (injected clock), final `succeeded`, `attempts = 3`. Permanent error goes straight to `dead` with `last_error` free of payload/PII.
7. Expiry: a job past `expires_at` becomes `cancelled` without invoking the handler.
8. Series speed: fake CalDAV with 500 ms latency; `createSeries` with 12 occurrences returns with the fake having received 0 calls; after draining, 12 PUTs and 1 summary email; booking rows and job rows consistent. No timing-based assertion on the request (assert "provider not called before drain" instead of a wall-clock bound, to avoid flakiness).
9. Cancel-after-book race: book then cancel immediately; after draining, no calendar event remains (fake provider state empty) and no "confirmed" email was sent if `cancelPending` removed it.
10. Idempotent create: fake provider returns 412 on second PUT of the same UID; job succeeds.
11. Handlers no-op correctness: cancelled booking -> create handler does not PUT; deleted booking -> no error.
12. Graceful shutdown: start the worker, begin a slow job, call close with grace shorter than the job; lease is released, `attempts` not burned, another worker finishes it.
13. Admin endpoints: list/stats/detail/retry/cancel/run authorization (user and teacher get 403), retry resets a dead job, payload masking, audit row written.
14. Migration test `migration-0020.test.ts`: table, check constraints, partial indexes exist; the `when` is greater than 0019's.
15. HTTP-level: `POST /schedule/series` returns 201 with the same body shape as before (snapshot of keys), contact returns `{ ok: true }` with SMTP fake throwing at enqueue time irrelevant to the response.
16. Regression: existing suites (`series`, `reminders`, `credit-balance`, `payment-verification`, `calendar-sync`) pass unchanged; mocks that asserted inline `createEvent`/`sendMail` calls move their assertions to "job enqueued" plus "handler does X when drained".

### 5.17 Metrics and logging

- One structured log line per job attempt: `{ jobId, type, attempt, maxAttempts, outcome: ok|retry|dead|skipped|lease_lost, durationMs, lagMs (start - run_at), errClass }`. No payload, addresses, names or provider bodies (same discipline as `reminders.service.ts`: booking id and `errName` only).
- Every 60 s, if anything happened, one summary line: claimed/succeeded/retried/dead/expired, queue depth by status, oldest pending age (the key SLI: enqueue-to-start lag).
- `GET /admin/jobs/stats` exposes the same numbers on demand. The repo has no metrics library (no `prom-client` in `package.json`), so a Prometheus endpoint is a later, optional step; the stats endpoint and logs cover the P1 bar.
- Correlation: `request_id` on the row links to the HTTP request log line (Fastify logger) and `app.request_logs` (that table stores path/status/duration per request; it has no request id column, so correlation there is by user id + time, not verified as sufficient).

### 5.18 Risks specific to Phase 1

- Eventual consistency surprises: a UI that expected `gcalEventId` immediately. Mitigation: documented in 5.12; the campus does not appear to rely on it.
- Dev behavior change (5.10). Mitigation: manual run endpoint, explicit flag.
- Double emails on rare crash timing (5.7). Accepted; Message-ID dedupe softens it.
- Poorly bounded queue growth during a long outage. Bounded by `expires_at` for class-related jobs and by retention; stats expose lag.
- `schedule.service.ts` is 810 lines and `payments.service.ts` 1105 lines; the edits are surgical but the review diff will be large. Split by the rollout steps in 5.15 (one PR per step).

---

## 6. Phases 2-6 at medium depth

### 6.1 Phase 2: CalendarProvider port

Interface sketch (domain-level; no CalDAV/ICS types leak out):

```ts
export type CalendarCapability = "createEvent" | "deleteEvent" | "updateEvent" | "listBusy" | "attendeeInvites";

export interface CalendarEventInput {
  uid: string;                 // deterministic, = booking id (kept for the calendar-sync self-skip rule)
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  attendees?: { email: string; name?: string }[];
  organizer: { email: string; name: string };
}

export interface BusyInterval { startsAt: Date; endsAt: Date; allDay: boolean; key: string /* stable per instance */; title?: string /* never leaves the admin boundary */ }

export interface CalendarConnectionRef { id: string; provider: string; teacherId: string; config: unknown /* decrypted by the factory, never logged */ }

export interface CalendarProvider {
  readonly kind: "caldav" | "google" | "outlook";
  readonly capabilities: ReadonlySet<CalendarCapability>;
  /** Idempotent: re-creating the same uid must succeed (CalDAV 412 handled inside). */
  createEvent(input: CalendarEventInput, opts: { signal: AbortSignal }): Promise<{ externalId: string; etag?: string }>;
  /** Idempotent: missing event is success. */
  deleteEvent(uid: string, opts: { signal: AbortSignal }): Promise<void>;
  updateEvent?(uid: string, patch: Partial<CalendarEventInput>, opts: { signal: AbortSignal }): Promise<void>;
  listBusy(range: { from: Date; to: Date }, opts: { signal: AbortSignal; expand?: boolean }): Promise<BusyInterval[]>;
  /** Cheap credential/reachability check for the connect screen and health. */
  verify(opts: { signal: AbortSignal }): Promise<{ ok: boolean; reason?: "auth" | "network" | "not_found" | "unsupported" }>;
}

export interface CalendarProviderFactory {
  for(connection: CalendarConnectionRef): CalendarProvider;     // pure construction, no I/O
}
```

Notes:
- Error taxonomy: adapters throw `ProviderTransientError` / `ProviderPermanentError` / `ProviderAuthError`; P1's `classifyError` is the only consumer, so handlers stay unchanged.
- Contract test suite parameterized over adapters (fake in-memory, CalDAV against the existing fake CalDAV server used by `calendar-sync.integration.test.ts`, later Google/Outlook against recorded fixtures).
- `ics.ts`/`caldav-report.ts` move under `adapters/calendar/caldav/`; `buildIcal` becomes the CalDAV adapter's private serializer (the email `.ics` attachment still needs it; share through a small `ics` util).
- P2 keeps ONE connection sourced from env so it ships without a schema change.

### 6.2 Phase 3: roles, teacher entity, per-teacher connection

**Role model.** Keep the Postgres enum (values cannot be dropped from a Postgres enum anyway). API-level naming: `student` is an alias of stored `user`; new code and the JWT use a `roles` helper, legacy `user` keeps working. Teacher capability is derived from having an active `teacher_profiles` row, not only from `role = 'teacher'`, so the owner (role `admin`) can also be a teacher without two accounts (open decision 3). Permissions are a code-defined map `role/capabilities -> permission strings`, checked by one guard `requirePermission("bookings:read:any")` replacing the four `requireAdmin` copies. A teacher JWT carries `role`; scoping uses `sub`, never a client-supplied teacher id.

RBAC matrix (A = admin, T = teacher, S = student; "own" = rows where the actor is the owner; "own students" = students with at least one non-cancelled booking with that teacher or explicitly assigned):

| Resource / action | Admin | Teacher | Student | Notes |
|---|---|---|---|---|
| Accounts: list/create/edit/block/delete users | all | no | no | |
| Change roles, create teachers | yes | no | no | |
| Impersonate a user | yes (audited, with impersonator claim) | no | no | adds `act` claim; writes `audit_logs` (P3) |
| Own profile read/update | yes | yes | yes | |
| Teacher profile edit | any | own | no | |
| Teacher directory (public fields) | yes | yes | yes | public fields only |
| Student list | all | own students | no | |
| Student PII (email, whatsapp) | all | email + name of own students; no whatsapp unless student opts in | own | |
| Student profile/skills | all | own students if `visible_to_teachers` | own | P4 |
| Weekly slots / availability / blocked slots | any teacher | own | read (via slots endpoint) | |
| Calendar connection (connect/verify/disconnect) | any (view status only; secrets never returned) | own | no | |
| Bookings: list | all | own (by `teacher_id`) | own | |
| Book for a student | yes | own students, own slots | self | |
| Cancel/reschedule a booking | any, no cutoff | own bookings, no student cutoff | own, 24 h cutoff (configurable) | cutoff moves to settings |
| Mark attendance | any | own bookings | no | |
| Class notes: write | any | own bookings | no | |
| Class notes: read | any | own bookings | own bookings | |
| Series: create/cancel for a student | any | own students | self | |
| Credits: view | all | own students' balance (read) | own | |
| Credits: grant/adjust | yes | no | no | |
| Orders/payments/proofs/coupons/payment methods | yes | no | own orders | teachers never see financial data |
| Products/catalog sync | yes | read | read active | |
| Job queue admin (P1) | yes | no | no | |
| Calendar-sync status/conflicts | all | own | no | |
| Courses: author/manage (P5) | yes | own (instructor) | no | |
| Courses: watch / progress | yes (preview) | yes (preview) | entitled only | |
| Reports | all | own | no | |
| Instance settings, licensing | yes | no | no | |

Per-teacher data isolation (authoritative design):
1. Every query path that returns teacher-owned data takes an `Actor { id, roles, isTeacher }` and applies a scope predicate from one helper (`scopeBookings(actor)`, `scopeStudents(actor)`); handlers never build ad-hoc filters. This is the application-level guard.
2. Mandatory cross-teacher test matrix: for each resource above, teacher B gets 403/404 (never 200 with empty data that leaks existence) on teacher A's ids, in an integration suite that runs in CI.
3. Postgres row-level security with `SET LOCAL app.actor_id` per transaction is the defense-in-depth option. Cost: every request needs a transaction with `SET LOCAL` and pooled-connection discipline. Deferred (open decision list does not need it for P3; recommended as a later hardening once a second real teacher exists).
4. Admin is instance-wide by design (the buyer). Teachers are not tenants of each other; they are staff of one business.

Data model sketch (names indicative; DDL belongs to the P3 spec):

```sql
-- teaching schema (new)
teaching.teacher_profiles (
  account_id uuid PK REFERENCES users.accounts,
  display_name text NOT NULL, bio jsonb NOT NULL DEFAULT '{}',   -- {es,en}
  timezone text NOT NULL DEFAULT 'UTC',
  is_active boolean NOT NULL DEFAULT true,
  accepts_bookings boolean NOT NULL DEFAULT true,
  created_at timestamptz, updated_at timestamptz);

teaching.product_teachers (product_id uuid, teacher_id uuid, PRIMARY KEY(product_id, teacher_id));
  -- no rows for a product = any teacher may serve it

scheduling.bookings ADD COLUMN teacher_id uuid REFERENCES users.accounts;  -- backfilled from weekly_slots/availabilities,
  -- fallback = the owner account; then SET NOT NULL; index (teacher_id, starts_at)

scheduling.calendar_connections (
  id uuid PK, teacher_id uuid NOT NULL, provider text NOT NULL,   -- 'caldav' now
  label text, status text NOT NULL,                               -- active|auth_failed|disabled
  config_enc bytea NOT NULL,                                      -- AES-256-GCM, key from env APP_ENCRYPTION_KEY
  sync_enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz, last_error text,
  UNIQUE (teacher_id, provider, label));

scheduling.booking_calendar_events (
  booking_id uuid, connection_id uuid, external_id text, etag text, status text, PRIMARY KEY (booking_id, connection_id));

scheduling.blocked_slots ADD COLUMN connection_id uuid;           -- caldav rows belong to a connection
platform.settings (key text PK, scope text, value jsonb, is_secret boolean);   -- 7.1
```

Migration of the owner's data: a one-time step creates the owner's `teacher_profiles` row (id = current `MENTORING_TEACHER_ID`), a `calendar_connections` row from the current `CALDAV_*` env vars, backfills `bookings.teacher_id`, and links existing `blocked_slots` rows to the connection. The env vars stay readable as a bootstrap fallback for one release.

Campus changes (high level): permission-driven nav (replace the binary switch at `layouts/default.vue:23`), `useSession` role type extended, teacher home (own agenda, own students, availability, connection status), teacher-scoped admin pages reused with scope, login landing by role.

API conventions from P3: new endpoints under `/v1`, `AppError` envelope, zod schemas, pagination `{ data, nextCursor }`. Legacy endpoints stay frozen until the campus is migrated.

### 6.3 Phase 3 prerequisite cleanups (kept explicit so P6 is not blocked)

- Replace hardcoded owner strings/addresses/timezone/Jitsi host with settings (7.1).
- Replace the boot-time `seedMentoring` with a first-run setup flow (7.3).
- Fix the JWT `role` type to the real union; keep `sub` as the only identity used for scoping.
- Extract one `requirePermission` and delete the four `requireAdmin` copies.

### 6.4 Phase 4: skills and profiles

Data model:

```sql
profiles.skills (
  id uuid PK, slug text UNIQUE NOT NULL,
  parent_id uuid REFERENCES profiles.skills,            -- 2 levels: domain (Development, Design) -> skill (Full-stack, Mobile, Native, Graphic design)
  names jsonb NOT NULL,                                 -- {"es":"...","en":"..."}
  status text NOT NULL DEFAULT 'active',                -- active|proposed|merged
  merged_into uuid, created_by uuid, created_at timestamptz);
profiles.skill_aliases (skill_id uuid, alias text, locale text, UNIQUE(alias, locale));

teaching.teacher_skills (teacher_id uuid, skill_id uuid, level smallint /*1-5*/, years smallint, is_primary boolean,
                         PRIMARY KEY (teacher_id, skill_id));

profiles.student_profiles (
  account_id uuid PK, goals text, experience_level text,       -- beginner|intermediate|advanced
  preferred_language text, timezone text,
  visible_to_teachers boolean NOT NULL DEFAULT true,           -- consent switch
  onboarding_completed_at timestamptz);
profiles.student_skills (student_id uuid, skill_id uuid, intent text /* 'learn'|'know' */, priority smallint,
                         PRIMARY KEY (student_id, skill_id, intent));

catalog.product_skills (product_id uuid, skill_id uuid, PRIMARY KEY (product_id, skill_id));
  -- source of truth: WP product meta, synced like products today
```

Taxonomy rules: seeded starter set per instance (full-stack web, mobile, native, graphic design, ...), teachers may PROPOSE a skill (`status = proposed`), admin approves/merges (merge rewrites join rows and records `merged_into`). Free-text goals stay free text; no ML.

Matching (deterministic SQL, explainable): score = sum over (student `learn` skills intersect teacher skills) of `level * priority_weight`, plus language match, plus "has bookable availability in the next 14 days". Endpoints: `GET /v1/teachers?skill=&language=&q=` (public fields, usable by site widgets), `GET /v1/students/:id/matches` (teacher/admin). Product tie-in: a product with `product_skills` and `product_teachers` narrows the teacher list shown in the booking flow. Availability tie-in: "next available slot" computed from the teacher's weekly slots minus blocks and bookings, reusing the P3 teacher-scoped functions.

Privacy: student profile visible only to teachers they have booked with (or all teachers if the student opts in); export/delete of profile data supported (needed for buyers subject to data-protection laws; confirm per market, not verified).

Campus screens (high level):
- Student: onboarding wizard (goals, skills to learn, skills known, language, timezone), profile page, teacher directory with skill filters, booking flow filtered by chosen teacher.
- Teacher: profile editor (bio per language, skills with level), "my students" list with the student card (goals/skills/notes), availability and calendar connection.
- Admin: skill taxonomy manager (approve, merge, rename), teacher management.

### 6.5 Phase 5: pre-recorded courses

Principles: WordPress stays the source of truth for catalog and lesson structure; the hub keeps a read-model plus access and progress (the same pattern as products via `lib/wp.ts` + webhook sync).

Catalog:
- WP content type `nodus_course` (or a `kind` field on `nodus_product`) with a lessons repeater: title, order, duration, `videoProvider`, `videoRef`, `isPreview`. `mapWpItem` must stop requiring `creditsCount` for non-credit products (today it skips them, 2.6): add `productKind = credits | course` and validate per kind.
- Hub read-model:

```sql
learning.courses (id uuid PK, product_id uuid UNIQUE REFERENCES ecommerce.products, slug text, status text, instructor_id uuid NULL);
learning.lessons (id uuid PK, course_id uuid, external_id text, position int, title text, duration_s int,
                  video_provider text, video_ref text, is_preview boolean, UNIQUE (course_id, external_id));
learning.lesson_progress (user_id uuid, lesson_id uuid, position_s int, completed_at timestamptz, updated_at timestamptz,
                          PRIMARY KEY (user_id, lesson_id));
```

Purchase and fulfillment: reuse the existing cart -> order -> payment flow. Add an order kind `course_enrollment` to `OrderKindRegistry` (the registry already supports multiple kinds/versions, `kind-registry.ts`). Refactor `applySettlementSideEffects` into a per-kind fulfiller registry (credits fulfiller = today's code; course fulfiller = grant access). This refactor is the real work and is also what Shopify/external orders need in P6.

Entitlement: `ecommerce.content_access` already models it (user, content type/external id, reason order, `valid_until`, `revoked_at`, partial unique index per order, `checkContentAccess`). Course access = a row with the course product's `(content_type, external_id)`. Refund/chargeback revokes (`revoked_at`). Time-limited access via `valid_until` (the `products.metadata` pattern, like `validityDays`).

Playback authorization: `POST /v1/learning/lessons/:id/playback` -> checks `checkContentAccess` (or `is_preview`), then asks the `VideoProvider` for a short-lived signed playback URL/token (5 min); the campus never holds a permanent URL.

```ts
export interface VideoProvider {
  readonly kind: "bunny" | "mux" | "vimeo" | "cloudflare" | "external" | "selfhosted";
  signedPlayback(videoRef: string, ctx: { userId: string; ttlSeconds: number }): Promise<{ url: string; type: "hls" | "embed" | "mp4"; expiresAt: Date }>;
  describe(videoRef: string): Promise<{ durationSeconds?: number; ready: boolean }>;
}
```

Progress: the player posts position every ~15 s (`PUT .../progress`), marks complete at about 90% watched; course progress is derived. Campus: course library, course page (modules/lessons, resume), player (HLS via hls.js or embed), progress bar. Certificates and quizzes deferred.

Video hosting trade-offs (pricing models vary and change; verify current prices before deciding, I did not check):

| Option | Strengths | Weaknesses | Fit |
|---|---|---|---|
| Self-hosted (object storage + ffmpeg HLS + nginx/CDN) | no per-minute fees, full data ownership, no vendor lock | you own transcoding, bandwidth, signed-URL logic, scaling; heavy to ask every buyer to run | good as a late "bring your own infra" adapter |
| Bunny Stream | simple API, HLS, token authentication, storage+bandwidth pricing model that is typically cheap, library-per-buyer | smaller analytics, vendor dependency | best default for resale: each buyer brings their own account |
| Mux | best developer experience, signed playback, strong analytics, adaptive quality | pricing per minute stored and delivered, usually the most expensive at small scale | premium option |
| Vimeo | easy embeds, domain-level privacy, familiar to buyers | plan limits, branding/embed constraints, API less suited to per-viewer signing | acceptable "external embed" path |
| Cloudflare Stream | simple, signed URLs, per-minute storage + delivery pricing model | per-minute pricing similar tradeoff to Mux, fewer player features | solid alternative |
| External embed (unlisted YouTube/Vimeo URL) | zero cost/effort | no real access control, URL can leak | only as a stopgap |

Recommendation: ship the `VideoProvider` port with `external` and Bunny adapters first; buyers configure their own account in instance settings.

### 6.6 Phase 6: distribution and extension points

Everything below must be designable now, built later. Architectural implications to honor from P3 onward:

| Concern | Decision to keep the door open |
|---|---|
| Public API contract | `/v1` prefix for new endpoints, single error envelope, zod schemas -> generated OpenAPI (not in deps today), additive-only changes inside v1, deprecation headers |
| Auth for machines | API keys: `platform.api_keys (id, name, prefix, key_hash, scopes[], created_by, last_used_at, revoked_at)`, hashed at rest, shown once; scopes like `catalog:read`, `bookings:create`, `orders:ingest`; rate limits per key (`@fastify/rate-limit` is already used on auth/portfolio/contact routes) |
| Auth for end users on a host site | token exchange (SSO): the host plugin's server signs a short-lived assertion with the instance secret; `POST /v1/sso/exchange` maps host user -> account by verified email and returns a campus session. Avoids asking WP/Shopify customers to log in twice |
| CORS and embedding | allowed origins moved from the in-code array (`app.ts`) into instance settings (admin-managed list); embeds use scoped keys, never admin JWTs |
| Outbound webhooks | events `booking.created|cancelled|rescheduled`, `order.paid|refunded`, `enrollment.created|revoked`, `credit.granted`; `platform.webhook_endpoints (url, secret, events[])`; delivery = `webhook.deliver` job type from P1 with HMAC-SHA256 signature header, timestamp, retry/backoff and dead-letter visibility for free |
| Inbound webhooks / external orders | `POST /v1/orders/external` with an idempotency key, for Shopify/other checkouts that take payment elsewhere, fulfilled through the P5 per-kind fulfiller registry |
| Catalog sources | `CatalogSource` port (`lib/wp.ts` becomes the WP adapter); `products` gets a `source` column; Shopify products and manual catalog follow |
| Embeddable widgets | web components with shadow DOM and CSS custom properties for theming (`<platform-booking>`, `<platform-teachers>`, `<platform-courses>`), served from the hub with versioned bundles, talk to `/v1` with a public-scope key |
| White-label | theming tokens + brand name + logo + email sender in instance settings; campus reads a `/v1/branding` document at boot; no brand strings in code |
| i18n | locale on every user-facing resource; API returns translated fields keyed by locale; WP side uses its own multilingual plugin; campus has `es`/`en` today (`i18n/locales`) |
| Licensing/activation | see 7.2; the connector side only needs a license-aware `/v1/instance` endpoint |

Sub-phases:
- 6a: `/v1` API hardening, OpenAPI, API keys, outbound webhooks, CORS in settings, `GET /v1/instance`. Exit: an external script with an API key lists catalog/teachers/slots and receives a signed `booking.created` webhook; docs published.
- 6b: WordPress plugin (server-to-server with an API key: shortcodes/blocks for booking, catalog and teacher directory, SSO exchange, webhook receiver). Thin: no business logic. Exit: install on a clean WP, connect with an instance URL + key, embed booking widget, a purchase shows in the campus.
- 6c: Shopify (app embed block + app proxy for widgets, `orders/paid` webhook -> `POST /v1/orders/external`, customer account link). Needs the external-orders path and per-kind fulfillers. Exit: a Shopify order grants credits/course access idempotently.
- 6d: Drupal and Joomla modules: embed widgets + SSO exchange only. Exit: widget renders, SSO works. They should be near-copies of 6b's client logic.

---

## 7. Cross-cutting

### 7.1 Single-tenant-per-deployment: what moves from env to DB

Rule: INFRASTRUCTURE secrets and addresses stay in env (DB URL, Redis URL, JWT secrets, SMTP credentials, `APP_ENCRYPTION_KEY`, payment-provider secrets). BUSINESS configuration an admin should change without redeploying goes to DB (`platform.settings`, secrets encrypted with `APP_ENCRYPTION_KEY`).

| Config | Today | Target |
|---|---|---|
| Calendar connection(s) | `CALDAV_URL/USERNAME/PASSWORD` | `calendar_connections` per teacher (P3) |
| Teacher identity | `MENTORING_TEACHER_ID` | `teacher_profiles` (P3) |
| Admin notification inbox | `ADMIN_NOTIFICATION_EMAIL` env + hardcoded `hola@jesusuzcategui.com` (contact, portfolio) | setting |
| Brand: name, from-name, colors, logo, email footer | `SMTP_FROM_NAME`, `BRAND_COLOR`, strings | settings |
| Timezone, cancel cutoff, slot length, credit validity default | `America/Bogota` literals, 24 h, 1 h, 60 d | settings (timezone per instance, per-teacher override later) |
| Meeting link provider/base URL | `JITSI_BASE_URL` + hardcoded host in portfolio | `MeetingLinkProvider` setting |
| CORS origins, public/campus URLs | in-code array + `CAMPUS_ORIGIN`/`PORTFOLIO_ORIGIN`/`APP_PUBLIC_URL` | settings |
| Payment method toggles | already DB (`ecommerce.payment_method_settings`) | unchanged |
| Video provider credentials | n/a | settings (P5) |
| Locale defaults | `accounts.locale` default `es` | setting |

Bootstrapping: env values keep working as defaults for one release after the settings table exists; the setup flow imports them.

### 7.2 Licensing and activation (design only)

- Model: signed license document (Ed25519 signature, public key shipped in the image) containing instance id, licensee, features, limits (max teachers, courses enabled, connectors enabled), issued/expiry, and a grace window. Verified offline at boot and daily. Optional online activation against the owner's license service for revocation/renewal (the owner's existing "Hub Vanjex" project is a candidate host, per owner notes; not verified from this repo).
- Failure policy: never break running classes because a license server is unreachable. Expired/invalid license degrades gracefully: existing data and scheduled classes keep working, adding new teachers/courses or enabling new connectors is blocked, with a visible banner. This protects the buyer's customers.
- Enforcement points are few: teacher creation, course publishing, API key creation, connector enablement. Keep them behind one `license.can("feature")` call so the commercial policy can change without touching business code.
- Honest limit: any self-hosted license check is circumventable by someone with the source. Treat it as contractual and convenience-grade, not DRM. The image/source distribution plan (open decision 9) matters more than the check.

### 7.3 Distribution and upgrade story for buyers

Gaps found in the repo that block shipping to someone else:
- `hexagonal-payments-core` is a private GitHub git dependency; the `Dockerfile` needs `GH_TOKEN` at build time (`Dockerfile`, `package.json`). Buyers cannot build this. Publish it to a registry or vendor it before P6.
- Migrations run at every boot (`server.ts`) which is convenient for single-node but needs: a pre-migration backup note, forward-only policy, and a `schema_version` visible in `/v1/instance`. `db/migrate.ts repairSchema` re-applies idempotent DDL for migrations 0005/0006 on every boot, which indicates historical drift on the owner's database; a fresh buyer database should not need it (not verified that 0005/0006 alone reproduce the same schema; test a from-scratch migrate before shipping).
- `seedMentoring` on every boot with owner data and an owner email (2.3) must become a first-run setup wizard (`/setup`: create first admin, instance name, timezone, optional demo slots), disabled once an admin exists. `scripts/grant-admin-and-reset-password.mjs` stays as a recovery tool.
- Provide a compose bundle (app, Postgres, Redis if kept, optional Caddy as `Caddyfile.example` already hints) and a documented upgrade command. Backups: `pg_dump` guidance and a restore drill, plus the video provider and WebDAV (proof/notes storage, `plugins/webdav.ts`) data location called out because they are outside Postgres.
- Redis is unused today (2.1). Decide whether to keep it as a dependency for buyers (open decision 1 touches this). Removing an unneeded service lowers install friction.

### 7.4 Security and isolation

- Secrets at rest: calendar connection credentials AES-256-GCM encrypted with an env master key, never returned by any API, never logged; key rotation procedure documented.
- Teacher-supplied URLs (CalDAV server address) are an SSRF vector once teachers can configure connections: validate scheme, resolve and reject private/link-local ranges unless an instance flag allows self-hosted private networks, enforce timeouts and response size caps.
- Impersonation must record the actor (`act` claim, `audit_logs` row). Today neither exists (2.2).
- Login/session: access JWT is HS256 with a single shared secret. If third-party connectors ever verify tokens, move to asymmetric (EdDSA/RS256) or keep verification server-side only. Not needed before P6.
- Per-teacher isolation: 6.2 (scope helper, cross-teacher test matrix, RLS as later hardening).
- PII minimization in jobs and logs (5.14, 5.17).
- Rate limiting exists on auth, portfolio and contact routes via `@fastify/rate-limit`; extend to API keys in P6a.
- Webhook signature verification already exists for ePayco/PayPal and WP (`X-Webhook-Secret` with `timingSafeEqual`, `products.routes.ts`); outbound webhooks reuse the same HMAC discipline.

### 7.5 i18n

- Accounts carry `locale` (`es|en`, CHECK constraint in migration 0016); student emails are localized by builders in `schedule/student-emails.ts`. Several messages are Spanish-only regardless of locale (admin booking notice, review alert, password reset, cart link in one language variant). Consolidate into a template catalog keyed by locale (`email.<template>.<locale>`) with fallback to the instance default; handlers in P1 keep today's strings (no behavior change), the catalog consolidation is P3.
- Content i18n lives in WP (multilingual plugin), the hub stores `jsonb` per-locale fields where it owns content (skills, bios) and returns them by `?locale=`/`Accept-Language`.
- Dates: stop hardcoding `America/Bogota` and `-05:00` literals; store UTC, render by the teacher/student/instance timezone setting. The slot generator (`upcomingOccurrences`, `series.ts`) is the main place that needs a timezone-aware rewrite.

### 7.6 Observability

- Today: Fastify pino logs (`logger: true`), a `request_logs` row per request via an `onResponse` hook (every request writes to Postgres; volume grows unbounded, no retention found), `/health` returns `{ status: "ok" }` without checking DB or Redis.
- Add in P1: job logs/stats (5.17). Add by P3: `/health/ready` (DB reachable, migrations current, jobs lag under threshold), request-log retention, correlation id propagation (`request_id`), optional Prometheus `/metrics` and an error-tracking hook (Sentry adapter) behind env flags. Each is optional per buyer.
- Alerting minimum: dead-job count and oldest-pending age on the admin dashboard; optional throttled admin email on first dead job in an hour.

---

## 8. Open decisions for the owner

Numbered, each with options, my recommendation and the cost of being wrong.

1. **Queue substrate for P1.** (a) Postgres outbox + in-process worker only; (b) outbox + BullMQ relay now. Recommend (a). Cost of wrong: if you later need Redis-grade throughput, you add a relay and a new consumer (about S) while the write path and tests stay; choosing (b) now adds a Redis dependency for every buyer and two failure modes before you have the volume. Related: Redis is unused today; decide whether it stays in the install bundle.
2. **Worker placement.** (a) embedded in the API process behind `JOBS_ENABLED`; (b) separate worker process from day one. Recommend (a) because it matches reminders/calendar-sync/payment-verification and keeps one container per buyer; claim logic is process-agnostic, so moving out later is cheap. Cost of wrong: a slow handler can steal CPU from HTTP; mitigated by concurrency 4 and timeouts. Revisit when a buyer runs high volume.
3. **How an admin who also teaches is modeled.** (a) teacher capability = existence of an active `teacher_profiles` row, independent of `role` (the owner is admin AND teacher); (b) single `role` column and a second account for teaching; (c) change `role` to an array. Recommend (a). Cost of wrong: (b) makes the owner juggle two logins and splits their data; (c) is a large auth refactor with little gain.
4. **Where calendar credentials live.** (a) DB, AES-256-GCM with a master key in env; (b) KMS/Vault; (c) keep env only (single connection). Recommend (a) for P3. Cost of wrong: (c) cannot support a second teacher; (b) adds infrastructure no buyer will run; losing the master key makes connections unrecoverable (document backup of the key).
5. **Denormalize `bookings.teacher_id` in P3.** Recommend yes (backfilled, then NOT NULL). Cost of wrong: deriving the teacher through `weekly_slots`/`availabilities` joins forever, which breaks for reassigned slots, deleted slots (`ON DELETE restrict` today) and every per-teacher query/index.
6. **Role naming.** Keep stored enum `user|admin|teacher`, introduce `student` only at API/UI level. Recommend that. Cost of wrong: renaming the enum value requires a migration touching every account and a coordinated campus release for little product value.
7. **P4 before or after P5.** (a) keep order (profiles then courses); (b) courses first if a paying course is planned within about 3 months, with only a minimal teacher profile in P3. Recommend (b) if the course revenue is near-term, otherwise (a). Cost of wrong: delaying revenue (if you pick a) or shipping courses without teacher matching (acceptable; they are independent).
8. **Default video provider adapter.** Recommend the `VideoProvider` port with `external` + Bunny first, buyers bring their own account. Alternatives: Mux (best DX, pricier), self-host (most work). Cost of wrong: re-encoding/migrating videos between providers is a content-ops problem, not a code problem, so keep `video_ref` provider-scoped and never expose provider URLs publicly.
9. **Licensing model and how you distribute the product** (source access vs built images). Recommend offline-verifiable signed license + optional online activation, graceful degradation, ship built images (not source) and publish `hexagonal-payments-core` to a registry first. Cost of wrong: a mandatory phone-home breaks buyers' classes during your outage; honor-system-only gives no leverage; handing over source makes any check cosmetic. **Owner requirements added 2026-10-07 (binding for the licensing design):** the commercial version needs a licensing section; a buyer activates the install with a license key set in the instance environment (validated at install/boot, not a UI the end user sees); licensing must let the owner know how many copies were sold, and until what point support is granted per customer (support entitlement/expiry tied to the license). This is the same system as the planned owner-side console and software-licensing project (see memory/notes on the Nodus console, portal and Hub Vanjex licensing); design them together, with the hub only verifying and reporting, and the console issuing, revoking and counting.
10. **Contract strategy.** (a) `/v1` + normalized envelope for NEW endpoints from P3, legacy frozen; (b) rewrite the API before P6. Recommend (a). Cost of wrong: (b) stalls product work and risks the campus/Astro integration; ignoring it makes P6 a rewrite anyway.
11. **Worker behavior under `pnpm dev`.** (a) off by default with `POST /admin/jobs/run` and an explicit flag, same as the other three flags; (b) on, with a logging mail transport and a no-op calendar provider. Recommend (a) for consistency now; (b) is a nicer dev experience once P2 exists. Cost of wrong: either local bookings silently do nothing (a) or an unnoticed real send (if (b) is misconfigured). Note this is a behavior change from today, where inline booking emails and CalDAV PUTs do fire in dev.
12. **Google Calendar constraint.** The brief says Google needs a Workspace account the owner does not have, so P7 is deferred. Caveat to verify before treating this as permanent: Google's OAuth user-consent flow is generally available for consumer Google accounts too; Workspace is typically needed for domain-wide delegation with service accounts, not for per-user OAuth. I have not verified current Google policy (including app verification requirements for sensitive scopes). Recommend: keep P7 deferred as agreed, but do not describe it to buyers as impossible without checking. Cost of wrong: either overpromising a connector or leaving a differentiating feature on the table.
13. **Redis: optional in the product, enabled on the owner's instance (DECIDED 2026-10-07).** Finding: `REDIS_URL` is required at boot (`src/config/env.ts`) and `src/plugins/redis.ts` connects, but no module uses Redis; the cart lives in Postgres (`ecommerce.carts`), contradicting `hub-backend-plan.md` ("Carrito: Redis"), and `@fastify/rate-limit` (cart and contact routes) is not configured with a Redis store, so limits are per process. Decision: make Redis optional, with a small cache/limiter port that has two adapters, in-memory (default, single node, zero extra services) and Redis (enabled when `REDIS_URL` is set). The owner's own deployment runs with Redis to cache as much as is useful (WordPress catalog and legal-page responses, rate-limit counters shared across instances, later BullMQ if the Postgres queue is outgrown). Requirements: the hub must boot and behave correctly with no Redis; a Redis outage must degrade to the in-memory adapter (log and continue), never take the API down; the cart stays in Postgres (transactional with checkout, FK from orders); cache entries are keyed per deployment and invalidated by the WordPress product webhook. Cost of wrong: keeping Redis mandatory adds a service every buyer must run and makes a Redis failure a full outage; dropping it entirely loses shared rate limits when scaling to two instances. Schedule: a small slice right after P1 (size S), independent of the other phases; update `hub-backend-plan.md` to match reality.

---

## 9. Risks and deliberate deferrals

### 9.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| P1 touches 12 call sites in two 800-1100 line files | regression in booking/payments | one PR per rollout step (5.15), handler code is moved not rewritten, existing suites must pass, settlement last |
| Eventual consistency of calendar/email | UI expects instant side effects | documented, 201 body unchanged, `expires_at` and stats |
| Owner data migration in P3 (`bookings.teacher_id`, connections) | wrong backfill, orphan events | dry-run report first, backfill in a migration with a verification query, keep env fallback one release |
| Authz refactor in P3 | privilege leak between teachers | single scope helper + cross-teacher test matrix as a merge gate |
| Payments fulfillment refactor in P5 | double/failed grants | keep the credits fulfiller byte-for-byte, add the course fulfiller beside it, reuse the existing `needs_review` machinery |
| `hexagonal-payments-core` is a frozen, pinned private package | blocks buyers, limits changes | publish/vendor it before P6; treat kind registry extension as the only needed change |
| Settlement is not transactional (2.4 #9) | partial grants on crash | recorded as follow-up; `needs_review` machinery already catches failed grants |
| Timezone/slot code is Bogota-hardcoded | wrong slots for other regions | explicit P3 cleanup item (7.5) |
| Third-party app verification (Google/Microsoft) | long lead time for P7 | start only when a buyer needs it |
| Single maintainer capacity | roadmap slips | phases are independently shippable; P1+P2 already deliver the reliability win |

### 9.2 Deliberately deferred

- Moving reminders and payment re-verification onto the job queue (they work; convert opportunistically).
- Making settlement a single transaction and making reschedule atomic (pre-existing; separate fix, low risk with P1 landed).
- LISTEN/NOTIFY wakeups for the worker, per-provider rate limiting, job heartbeats, priorities/queues, scheduled/recurring jobs in the table.
- Prometheus endpoint, tracing, Sentry integration (optional adapters later).
- Postgres row-level security (defense in depth after a second real teacher exists).
- Certificates, quizzes, DRM, live classes, payouts/commissions, multi-tenant hosting, native apps, PWA.
- Google and Outlook adapters (P7).
- Campus UI for the job queue (endpoints ship in P1; screen is a small follow-up).
- Notifying admins of a series creation (today only single bookings notify admins, 2.4 #4 vs #1): preserved as is in P1; confirm whether that gap is intended.
