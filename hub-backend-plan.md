# Hub Backend — Plan de Implementación

Backend personal para e-commerce de clases de tutoría.
Stack: Fastify 5 + TypeScript + PostgreSQL + Redis + MercadoPago + Google Calendar.

---

## Modelo de Negocio

- **Producto:** clases de tutoría (sesiones de N minutos)
- **Compra:** única (1 sesión o paquete de N sesiones)
- **Post-pago:** estudiante puede agendar su(s) sesión(es) desde su perfil
- **Sesión:** evento en Google Calendar del profesor con Google Meet auto-generado
- **Contenido:** gestionado en Strapi CMS, vinculado al hub por `documentId`

---

## Contrato de Errores HTTP

**Regla absoluta:** el status code HTTP es la fuente de verdad. Nunca retornar `200` con `{ error: ... }` o `{ success: false }` en el payload.

### Status codes usados

| Code | Cuándo |
|------|--------|
| `200 OK` | Éxito con cuerpo |
| `201 Created` | Recurso creado |
| `204 No Content` | Éxito sin cuerpo (DELETE, logout) |
| `400 Bad Request` | Payload malformado o campos inválidos (falla Zod) |
| `401 Unauthorized` | No autenticado — token ausente, expirado o inválido |
| `403 Forbidden` | Autenticado pero sin permiso (ej: usuario sin rol admin) |
| `404 Not Found` | Recurso no existe |
| `409 Conflict` | Estado conflictivo — ej: email ya registrado, slot ya reservado |
| `422 Unprocessable Entity` | Datos válidos en forma pero inválidos en lógica — ej: créditos insuficientes, orden ya pagada |
| `429 Too Many Requests` | Rate limit excedido |
| `500 Internal Server Error` | Error no manejado del servidor |

### Formato de respuesta

**Éxito:**
```json
// 200 / 201
{ "data": { ... } }

// 204 — sin cuerpo
```

**Error:**
```json
// 4xx / 5xx
{
  "error": {
    "code": "SLOT_ALREADY_BOOKED",
    "message": "El slot seleccionado ya no está disponible"
  }
}
```

`code` es un string en SCREAMING_SNAKE_CASE — el frontend puede hacer switch sobre él sin parsear el mensaje.

### Ejemplos de códigos de error por módulo

| `code` | Status | Situación |
|--------|--------|-----------|
| `EMAIL_ALREADY_EXISTS` | 409 | Registro con email duplicado |
| `INVALID_CREDENTIALS` | 401 | Login con contraseña incorrecta |
| `TOKEN_EXPIRED` | 401 | Access token expirado |
| `TOKEN_REVOKED` | 401 | Refresh token ya usado o revocado |
| `INSUFFICIENT_CREDITS` | 422 | Sin créditos de clase disponibles |
| `SLOT_ALREADY_BOOKED` | 409 | Slot reservado entre la consulta y el booking |
| `ORDER_ALREADY_PAID` | 409 | Webhook duplicado de MercadoPago |
| `PRODUCT_NOT_ACTIVE` | 422 | Producto desactivado al momento del checkout |
| `ACCESS_DENIED` | 403 | Usuario sin acceso al contenido solicitado |
| `VALIDATION_ERROR` | 400 | Campos faltantes o con formato incorrecto |

### Implementación en Fastify

```typescript
// src/utils/errors.ts — clase base
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

// Uso en cualquier servicio/controller:
throw new AppError(409, 'SLOT_ALREADY_BOOKED', 'El slot seleccionado ya no está disponible')

// Error handler global en app.ts:
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof AppError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message }
    })
  }
  // ZodError → 400
  // Error genérico → 500 (no leak de stack trace en producción)
})
```

---

## Auth: Hybrid JWT + Opaque Refresh

| Token | Tipo | TTL | Storage | Transporte |
|-------|------|-----|---------|------------|
| Access | JWT HS256 `{ sub, role, iat, exp }` | 15 min | — (stateless) | `Authorization: Bearer` |
| Refresh | UUID 32-byte hex, SHA-256 hash en DB | 30 días | `users.refresh_tokens` | HttpOnly cookie |

- **Rotación:** cada refresh emite token nuevo, invalida anterior
- **Family ID:** reuso de token revocado → invalidar familia entera (detección de robo)
- **Social auth:** OAuth2 provider → user info → crear/linkear en `users.accounts` → emitir nuestros tokens
- **Password:** Argon2id (`memoryCost: 65536`, `timeCost: 3`, `parallelism: 4`)

---

## ORM: Drizzle + pg Pool existente

Drizzle envuelve el Pool sin reemplazarlo. Ambos decorators disponibles en Fastify:

```typescript
fastify.decorate('db', pool)                          // Pool raw — transacciones, SQL directo
fastify.decorate('drizzle', drizzle(pool, { schema })) // Drizzle — queries tipados
```

Migraciones: `drizzle-kit generate` → `drizzle/migrations/*.sql` (revisable, commitable).

---

## PostgreSQL Schemas

| Schema | Propósito | Reutilizable |
|--------|-----------|--------------|
| `users` | Cuentas, auth, tokens | Sí — independiente |
| `ecommerce` | Productos, pagos, acceso a contenido | Esta app |
| `scheduling` | Disponibilidad, créditos, reservas | Esta app |
| `app` | Request logs, audit logs | Sí — genérico |

```sql
CREATE SCHEMA users;
CREATE SCHEMA ecommerce;
CREATE SCHEMA scheduling;
CREATE SCHEMA app;

GRANT USAGE ON SCHEMA users, ecommerce, scheduling, app TO hubuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA users GRANT ALL ON TABLES TO hubuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA ecommerce GRANT ALL ON TABLES TO hubuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA scheduling GRANT ALL ON TABLES TO hubuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO hubuser;
```

---

## Schema: `users`

```sql
CREATE TYPE users.user_role AS ENUM ('user', 'admin');
CREATE TYPE users.provider_type AS ENUM ('google', 'github');

CREATE TABLE users.accounts (
  id             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT            NOT NULL UNIQUE,
  password_hash  TEXT,
  display_name   TEXT            NOT NULL,
  avatar_url     TEXT,
  role           users.user_role NOT NULL DEFAULT 'user',
  email_verified BOOLEAN         NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accounts_email ON users.accounts(email);

CREATE TABLE users.providers (
  id           UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID                NOT NULL REFERENCES users.accounts(id) ON DELETE CASCADE,
  provider     users.provider_type NOT NULL,
  provider_uid TEXT                NOT NULL,
  created_at   TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_provider_uid UNIQUE (provider, provider_uid)
);
CREATE INDEX idx_providers_lookup ON users.providers(provider, provider_uid);

CREATE TABLE users.refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users.accounts(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  family_id  UUID        NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_active ON users.refresh_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_tokens_family ON users.refresh_tokens(family_id);
```

---

## Schema: `ecommerce`

```sql
CREATE TYPE ecommerce.order_status AS ENUM ('pending', 'paid', 'failed', 'refunded', 'cancelled');
CREATE TYPE ecommerce.payment_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'in_mediation', 'charged_back');
CREATE TYPE ecommerce.payment_type AS ENUM ('one_time', 'subscription_charge');
CREATE TYPE ecommerce.billing_interval AS ENUM ('days', 'weeks', 'months', 'years');
CREATE TYPE ecommerce.subscription_status AS ENUM ('pending', 'active', 'paused', 'cancelled', 'expired');
CREATE TYPE ecommerce.access_reason AS ENUM ('order', 'subscription');

-- Productos (sincronizados desde Strapi via webhook)
CREATE TABLE ecommerce.products (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  strapi_document_id  TEXT        NOT NULL UNIQUE,
  strapi_content_type TEXT        NOT NULL,  -- 'api::tutorial-class.tutorial-class'
  slug                TEXT        NOT NULL UNIQUE,
  name                TEXT        NOT NULL,
  description         TEXT,
  price_cents         INTEGER     NOT NULL CHECK (price_cents >= 0),
  currency            CHAR(3)     NOT NULL DEFAULT 'ARS',
  sessions_included   SMALLINT    NOT NULL DEFAULT 1,  -- clases incluidas en la compra
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_slug          ON ecommerce.products(slug);
CREATE INDEX idx_products_strapi_doc_id ON ecommerce.products(strapi_document_id);

-- Planes de suscripción (para productos recurrentes futuros)
CREATE TABLE ecommerce.subscription_plans (
  id                     UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id             UUID                       NOT NULL REFERENCES ecommerce.products(id) ON DELETE RESTRICT,
  mp_preapproval_plan_id TEXT                       UNIQUE,
  name                   TEXT                       NOT NULL,
  price_cents            INTEGER                    NOT NULL CHECK (price_cents > 0),
  currency               CHAR(3)                    NOT NULL DEFAULT 'ARS',
  billing_interval       ecommerce.billing_interval NOT NULL,
  billing_frequency      SMALLINT                   NOT NULL DEFAULT 1 CHECK (billing_frequency > 0),
  trial_days             SMALLINT                   NOT NULL DEFAULT 0,
  is_active              BOOLEAN                    NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ                NOT NULL DEFAULT NOW()
);

-- Órdenes (pagos únicos)
CREATE TABLE ecommerce.orders (
  id               UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID                   NOT NULL REFERENCES users.accounts(id) ON DELETE RESTRICT,
  status           ecommerce.order_status NOT NULL DEFAULT 'pending',
  subtotal_cents   INTEGER                NOT NULL CHECK (subtotal_cents >= 0),
  total_cents      INTEGER                NOT NULL CHECK (total_cents >= 0),
  currency         CHAR(3)                NOT NULL DEFAULT 'ARS',
  mp_preference_id TEXT,
  mp_external_ref  TEXT                   UNIQUE,
  metadata         JSONB                  NOT NULL DEFAULT '{}',
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_orders_user_status     ON ecommerce.orders(user_id, status);
CREATE INDEX idx_orders_mp_external_ref ON ecommerce.orders(mp_external_ref);

CREATE TABLE ecommerce.order_items (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID        NOT NULL REFERENCES ecommerce.orders(id) ON DELETE CASCADE,
  product_id       UUID        NOT NULL REFERENCES ecommerce.products(id) ON DELETE RESTRICT,
  quantity         SMALLINT    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER     NOT NULL CHECK (unit_price_cents >= 0),
  total_cents      INTEGER     NOT NULL CHECK (total_cents >= 0),
  snapshot         JSONB       NOT NULL DEFAULT '{}',  -- datos del producto al momento de compra
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_items_order_id ON ecommerce.order_items(order_id);

-- Suscripciones (para productos recurrentes futuros)
CREATE TABLE ecommerce.subscriptions (
  id                   UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID                          NOT NULL REFERENCES users.accounts(id) ON DELETE RESTRICT,
  plan_id              UUID                          NOT NULL REFERENCES ecommerce.subscription_plans(id) ON DELETE RESTRICT,
  status               ecommerce.subscription_status NOT NULL DEFAULT 'pending',
  mp_preapproval_id    TEXT                          UNIQUE,
  mp_external_ref      TEXT                          UNIQUE,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  trial_ends_at        TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ                   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ                   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_user_status ON ecommerce.subscriptions(user_id, status);
CREATE INDEX idx_subscriptions_mp_id       ON ecommerce.subscriptions(mp_preapproval_id);

-- Pagos (log inmutable — no se edita, solo se inserta)
CREATE TABLE ecommerce.payments (
  id              UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID                     NOT NULL REFERENCES users.accounts(id) ON DELETE RESTRICT,
  order_id        UUID                     REFERENCES ecommerce.orders(id) ON DELETE RESTRICT,
  subscription_id UUID                     REFERENCES ecommerce.subscriptions(id) ON DELETE RESTRICT,
  payment_type    ecommerce.payment_type   NOT NULL,
  status          ecommerce.payment_status NOT NULL,
  amount_cents    INTEGER                  NOT NULL CHECK (amount_cents >= 0),
  currency        CHAR(3)                  NOT NULL DEFAULT 'ARS',
  mp_payment_id   TEXT,
  mp_raw_webhook  JSONB,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payments_ref CHECK (order_id IS NOT NULL OR subscription_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_payments_mp_id ON ecommerce.payments(mp_payment_id) WHERE mp_payment_id IS NOT NULL;

-- Acceso a contenido Strapi (derechos adquiridos)
CREATE TABLE ecommerce.content_access (
  id                  UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                    NOT NULL REFERENCES users.accounts(id) ON DELETE CASCADE,
  strapi_content_type TEXT                    NOT NULL,
  strapi_document_id  TEXT                    NOT NULL,
  reason              ecommerce.access_reason NOT NULL,
  order_id            UUID                    REFERENCES ecommerce.orders(id) ON DELETE CASCADE,
  subscription_id     UUID                    REFERENCES ecommerce.subscriptions(id) ON DELETE CASCADE,
  valid_from          TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  valid_until         TIMESTAMPTZ,            -- NULL = acceso permanente
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_content_access_source CHECK (order_id IS NOT NULL OR subscription_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_content_access_order
  ON ecommerce.content_access(user_id, strapi_content_type, strapi_document_id, order_id)
  WHERE reason = 'order' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_access_subscription
  ON ecommerce.content_access(user_id, strapi_content_type, strapi_document_id, subscription_id)
  WHERE reason = 'subscription' AND subscription_id IS NOT NULL;
CREATE INDEX idx_content_access_active
  ON ecommerce.content_access(user_id, strapi_content_type, strapi_document_id)
  WHERE revoked_at IS NULL AND (valid_until IS NULL OR valid_until > NOW());
```

---

## Schema: `scheduling`

```sql
CREATE TYPE scheduling.booking_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');

-- Slots de disponibilidad (admin/profesor los crea)
CREATE TABLE scheduling.availabilities (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID        NOT NULL REFERENCES users.accounts(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  is_booked  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_availability_range CHECK (ends_at > starts_at)
);
CREATE INDEX idx_availabilities_free ON scheduling.availabilities(starts_at) WHERE is_booked = FALSE;

-- Créditos de clase asignados tras pago confirmado
CREATE TABLE scheduling.class_credits (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users.accounts(id) ON DELETE RESTRICT,
  order_id      UUID        NOT NULL REFERENCES ecommerce.orders(id) ON DELETE RESTRICT,
  product_id    UUID        NOT NULL REFERENCES ecommerce.products(id) ON DELETE RESTRICT,
  total_credits SMALLINT    NOT NULL CHECK (total_credits > 0),
  used_credits  SMALLINT    NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  expires_at    TIMESTAMPTZ,   -- NULL = sin expiración
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_credits_used CHECK (used_credits <= total_credits)
);
CREATE INDEX idx_class_credits_user_id ON scheduling.class_credits(user_id);

-- Reservas concretas
CREATE TABLE scheduling.bookings (
  id               UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID                      NOT NULL REFERENCES users.accounts(id) ON DELETE RESTRICT,
  credit_id        UUID                      NOT NULL REFERENCES scheduling.class_credits(id) ON DELETE RESTRICT,
  availability_id  UUID                      NOT NULL REFERENCES scheduling.availabilities(id) ON DELETE RESTRICT,
  product_id       UUID                      NOT NULL REFERENCES ecommerce.products(id) ON DELETE RESTRICT,
  status           scheduling.booking_status NOT NULL DEFAULT 'pending',
  gcal_event_id    TEXT,
  meet_link        TEXT,
  starts_at        TIMESTAMPTZ               NOT NULL,
  ends_at          TIMESTAMPTZ               NOT NULL,
  student_notes    TEXT,
  reminder_sent_at TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ               NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bookings_student_id ON scheduling.bookings(student_id);
CREATE INDEX idx_bookings_starts_at  ON scheduling.bookings(starts_at);
```

---

## Schema: `app`

```sql
-- Request logs (llenado automáticamente via Fastify onResponse hook)
CREATE TABLE app.request_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES users.accounts(id) ON DELETE SET NULL,
  method      TEXT        NOT NULL,
  path        TEXT        NOT NULL,
  status_code SMALLINT    NOT NULL,
  duration_ms INTEGER     NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_request_logs_created_at ON app.request_logs(created_at);
CREATE INDEX idx_request_logs_status     ON app.request_logs(status_code);

-- Audit logs (acciones críticas: cambio de rol, revocación de acceso, etc.)
CREATE TABLE app.audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID        REFERENCES users.accounts(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,   -- 'user.role_changed', 'access.revoked', etc.
  target_id   UUID,
  target_type TEXT,
  payload     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_action     ON app.audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON app.audit_logs(created_at);
```

---

## Carrito: Redis (no DB)

```
cart:{userId}          HASH  — usuario autenticado, TTL 7 días
cart:guest:{sessionId} HASH  — invitado, TTL 7 días
```

- Merge en login: `RENAME cart:guest:{sid} cart:{userId}`
- Checkout: precios re-validados contra `ecommerce.products` antes de crear la orden

---

## Integración Strapi

| Dirección | Mecanismo | Descripción |
|-----------|-----------|-------------|
| Strapi → Hub | Webhook `onPublish/onUpdate/onUnpublish` | Upsert en `ecommerce.products` por `strapi_document_id` |
| Hub → Frontend | `GET /access/check` | Validar si el usuario tiene acceso a un `documentId` |
| Frontend → Strapi | Fetch directo | El frontend obtiene el contenido de Strapi directamente |

**Content type en Strapi:** `api::tutorial-class.tutorial-class`
Campos clave: `title`, `slug`, `duration_minutes`, `sessions_included`, `price`, `currency`, `is_active`.

---

## Integración Google Calendar

Autenticación: **Service Account** con delegación al calendario del profesor.
No requiere OAuth interactivo — el service account actúa en nombre del profesor.

Setup:
1. Crear Service Account en Google Cloud Console
2. Habilitar Google Calendar API en el proyecto
3. En Google Calendar del profesor → Settings → agregar service account email con permiso "Make changes to events"
4. Guardar credenciales en `.env`

Al crear una reserva:
- Se crea evento con `attendees: [student_email, teacher_email]`
- `conferenceData.createRequest` → Google Meet link auto-generado
- `reminders: [emailReminder 24h, emailReminder 1h]`
- `gcal_event_id` y `meet_link` guardados en `scheduling.bookings`

---

## Módulos — Orden de Implementación

| # | Módulo / Archivo | Propósito |
|---|------------------|-----------|
| 1 | `src/db/schema/` | Drizzle schemas: users.ts, ecommerce.ts, scheduling.ts, app.ts |
| 2 | `drizzle/migrations/` | SQL generado por drizzle-kit |
| 3 | `src/plugins/postgres.ts` | Añadir `fastify.drizzle` (mantener `fastify.db`) |
| 4 | `src/plugins/jwt.ts` | JWT plugin (jose) + hook `fastify.authenticate` |
| 5 | `src/config/env.ts` | Expandir con todas las vars + validación Zod |
| 6 | `src/modules/auth/` | Register, login, logout, OAuth Google/GitHub, token rotation |
| 7 | `src/modules/users/` | Perfil, admin, gestión de roles |
| 8 | `src/modules/products/` | Catálogo + endpoint sync de Strapi webhook |
| 9 | `src/modules/cart/` | Carrito Redis |
| 10 | `src/modules/checkout/` | Orden + MercadoPago preference |
| 11 | `src/modules/webhooks/` | MP IPN idempotente → confirmar pago → crear créditos |
| 12 | `src/modules/payments/` | Historial de pagos (lectura) |
| 13 | `src/modules/content-access/` | Validar acceso a contenido Strapi |
| 14 | `src/modules/scheduling/` | Disponibilidad, créditos, reservas, Google Calendar |
| 15 | `src/hooks/requestLogger.ts` | Fastify onResponse → app.request_logs |
| — | `src/modules/subscription-plans/` | Futuro — cuando se agreguen suscripciones recurrentes |

---

## Dependencias

### Producción

| Package | Propósito |
|---------|-----------|
| `drizzle-orm` | Query builder tipado, wraps pg Pool |
| `jose` | JWT sign/verify HS256 |
| `argon2` | Argon2id password hashing |
| `zod` | Validación de request bodies y env vars |
| `mercadopago` | SDK oficial MP (preferences, webhooks) |
| `googleapis` | Google Calendar API (crear eventos + Meet links) |
| `node-cron` | Cron job para recordatorios de clase |

### Dev

| Package | Propósito |
|---------|-----------|
| `drizzle-kit` | CLI migraciones (generate, migrate, studio) |
| `vitest` | Test runner |

---

## Variables de Entorno

```bash
# JWT
JWT_ACCESS_SECRET=          # openssl rand -hex 32
JWT_ACCESS_EXPIRY=900       # 15 min
JWT_REFRESH_EXPIRY=2592000  # 30 días

# OAuth Google (para autenticación de usuarios)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://hub.jesusuzcategui.com/auth/google/callback

# OAuth GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://hub.jesusuzcategui.com/auth/github/callback

# MercadoPago
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
MP_SUCCESS_URL=
MP_FAILURE_URL=
MP_PENDING_URL=

# Google Calendar (service account)
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
GOOGLE_CALENDAR_ID=         # ID del calendario del profesor

# Strapi
STRAPI_URL=https://cms.jesusuzcategui.com
STRAPI_WEBHOOK_SECRET=      # Para verificar webhooks entrantes de Strapi

# Cookies
COOKIE_SECURE=true
COOKIE_DOMAIN=hub.jesusuzcategui.com
```

---

## Archivos a Modificar (vs estado actual)

| Archivo | Cambio |
|---------|--------|
| `src/plugins/postgres.ts` | Añadir `fastify.drizzle` decorator |
| `src/config/env.ts` | Expandir + migrar validación a Zod |
| `src/app.ts` | Registrar plugin jwt + módulos nuevos |
| `docker-compose.yml` | Añadir nuevas env vars |
| `.env.example` | Añadir todas las vars nuevas |
| `pnpm-workspace.yaml` | Aprobar builds de argon2 (nativo) |

---

## Verificación Post-Implementación

1. `drizzle-kit migrate` → schemas `users`, `ecommerce`, `scheduling`, `app` visibles en DBeaver
2. `GET /health` → `{ "status": "ok" }`
3. `POST /auth/register` → access token + HttpOnly cookie con refresh token
4. `POST /auth/refresh` → nuevo access token, cookie rotada
5. Strapi webhook `POST /products/sync` → producto upsertado en `ecommerce.products`
6. `POST /checkout` → orden creada + MP preference URL devuelta
7. MP webhook de prueba → `order.status = 'paid'` + `class_credits` creados
8. `POST /scheduling/bookings` → evento creado en Google Calendar con Meet link
9. `GET /access/check?contentType=X&documentId=Y` → `{ "hasAccess": true }`
10. `app.request_logs` populated en cada request
