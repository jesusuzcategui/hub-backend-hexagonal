> Traducción al español de PLATFORM_ROADMAP_AND_SPEC.md. Ante cualquier diferencia, la versión en inglés es la fuente de verdad.

# Roadmap de la plataforma y especificación de la Fase 1

Estado: BORRADOR para revisión del propietario. No se ha realizado ningún cambio de código, migración, commit ni push para este documento.
Fecha: 2026-10-07. Rama inspeccionada: `staging` de `hub-backend-hexagonal` (solo lectura), más el campus Nuxt en `/home/jesusu/Workspace/jesusuzcategui/node/jesusuzcategui-campus`.

Cómo leer este documento: las secciones 1-4 son el roadmap, la sección 5 es la especificación implementable de la Fase 1, la sección 6 describe las Fases 2-6 con profundidad media, la sección 7 cubre los aspectos transversales, la sección 8 lista las decisiones que se requieren del propietario y la sección 9 lista riesgos y aplazamientos.

Convenciones utilizadas a continuación:
- "Verificado" = se leyó el código. Las referencias a archivos son `path:line` relativas a `src/` del repositorio del hub, salvo que se indique otra cosa. Los números de línea corresponden a esta lectura y irán desfasándose.
- "Reportado por el propietario" o "No verificado" = tomado del brief o inferido, no confirmado en el código.
- El repositorio hoy no tiene carpeta `docs/` (el único documento de planificación es `hub-backend-plan.md` en la raíz del repositorio, escrito en español). Se creó `docs/product/` para este archivo. Este documento está en inglés, según lo solicitado.

---

## 1. Visión y no objetivos

### 1.1 Visión

Una plataforma replicable y de nivel comercial para quienes ofrecen mentorías, sesiones de asesoría y cursos. Un comprador = un despliegue. El comprador obtiene:

- Una integración con el sitio web público (hoy un portafolio en Astro; más adelante conectores para WordPress/Shopify/Drupal/Joomla) para páginas, tienda y precios.
- Un WordPress headless como fuente de verdad del contenido y del catálogo de productos.
- El backend del hub: reservas, créditos, pagos, recordatorios, sincronización de calendario, cursos, derechos de acceso (entitlements).
- El campus (SPA en Nuxt): la aplicación de estudiantes, profesores y administración.

Nivel de calidad (vinculante, definido por el propietario): corrección bajo carga, trabajo en segundo plano durable con reintentos y visibilidad de fallos, proveedores intercambiables detrás de puertos, observabilidad, ninguna identidad del propietario fijada en el código. La infraestructura adicional es aceptable cuando se justifica. Hoy solo el propietario usa el sistema, por lo que hay margen para cambiar los internos, pero el campus y el sitio Astro dependen del contrato HTTP actual y no deben romperse silenciosamente.

### 1.2 No objetivos (explícitos)

- NO es un SaaS multi-tenant alojado. Sin columna de tenant en cada tabla, sin base de datos compartida entre clientes, sin facturación por tenant. Cada comprador ejecuta su propia instancia (propia DB, propio Redis, propios secretos). "Varios profesores dentro de una instancia" está dentro del alcance; "varios clientes en una instancia" no.
- NO hay integración con Google Calendar ni con Outlook/Microsoft 365 por ahora. El propietario no tiene una cuenta de Google Workspace. La Fase 7 es un marcador de posición; el puerto CalendarProvider (Fase 2) solo debe mantener esa puerta abierta. (Ver la decisión abierta 12 para una salvedad sobre la restricción de Google.)
- Sin funcionalidades de marketplace (pagos a profesores, comisiones, disputas). Los pagos llegan al propietario de la instancia.
- Sin aplicaciones móviles nativas ni PWA en estas fases (el roadmap de scheduling existente deja la PWA para el final).
- Sin DRM para video, sin certificados, sin transmisión en vivo en la Fase 5.
- Sin editor de RBAC editable en la DB. Los roles y permisos se definen en código.

---

## 2. Estado actual (fundamentado)

### 2.1 Stack y forma de ejecución

- Fastify 5 + TypeScript, drizzle-orm 0.45 sobre un `pg` Pool, zod 4, node-cron, nodemailer, ioredis, jose (JWT), argon2 (`package.json`).
- Un solo proceso hace todo: HTTP, jobs cron (recordatorios cada minuto `plugins/reminders.ts`, reverificación de pagos cada minuto `plugins/paymentVerification.ts`, sincronización CalDAV cada 5 minutos `plugins/calendarSync.ts`, purga diaria de cuentas `plugins/autoPurge.ts`) y migraciones al arrancar (`server.ts` llama a `runMigrations()` antes de `listen`).
- Schemas de Postgres: `users`, `ecommerce`, `payments`, `scheduling`, `app` (`db/schema/*.ts`). Las migraciones son archivos SQL escritos a mano `0000`..`0019` en `drizzle/migrations/` con `meta/_journal.json`; la siguiente es `0020`. Última entrada del journal: idx 19, tag `0019_blocked_slots_caldav`, `when` = `1791590400000`. El `when` de cada entrada avanza exactamente 86.400.000 ms (un día) respecto al anterior, p. ej. 0018 = 1791504000000.
- Redis se conecta al arrancar (`plugins/redis.ts`) pero no encontré ningún módulo que use `fastify.redis` fuera del propio plugin (`rg redis src` solo coincide con `app.ts` y el plugin). El carrito está respaldado por la DB (`ecommerce.carts`), no por Redis como indica `hub-backend-plan.md`. Redis debe tratarse como infraestructura actualmente sin uso.
- El `Pool` de Postgres se crea con valores por defecto (`plugins/postgres.ts`: `new Pool({ connectionString })`). El máximo por defecto de pg es 10 conexiones (valor por defecto de la librería, no configurado en este repositorio).
- No existe ningún manejador de SIGTERM/SIGINT (`rg "SIGTERM|SIGINT|process.on" src` no devuelve nada). Por tanto, los hooks `onClose` de Fastify (`task.stop()` de cron, cierre del pool) solo se ejecutan si algo llama a `app.close()`; con `docker stop` el proceso es terminado por el comportamiento por defecto de la señal.

### 2.2 Roles y autenticación

- Enum de DB `users.user_role` = `user | admin | teacher` (`db/schema/users.ts:5`). Valor por defecto `user`.
- El tipo del payload del JWT dice `role: "user" | "admin"` (`plugins/jwt.ts:8`), pero `issueTokens` acepta `"user" | "admin" | "teacher"` (`modules/auth/auth.service.ts:220`) y firma el rol que tenga la cuenta. Es decir, existe un token de teacher en tiempo de ejecución, pero está mal tipado.
- El access token es HS256 (simétrico), TTL de 900 s por defecto; los refresh tokens son opacos, con hash y rotación por familia (`auth.service.ts`, `env.ts`).
- Control de acceso de administración: `requireAdmin` está copiado y pegado cuatro veces (`modules/admin/admin.routes.ts:56`, `modules/products/products.routes.ts:13`, `modules/users/users.routes.ts:12`, `modules/class-notes/class-notes.routes.ts:19`), cada una con `request.user.role !== "admin"` -> 403. No hay una abstracción de permisos.
- Hoy se puede crear una cuenta con rol `teacher` (`POST /admin/students` acepta `role: user|teacher`, `PATCH /admin/students/:id` acepta `user|teacher|admin`, `admin.routes.ts:64-120`), pero es un rol muerto: toda ruta de administración lo rechaza, `/users/:id/role` solo permite `user|admin` (`users.schemas.ts:10`) y `listStudents` filtra `role = 'user'` (`admin.service.ts:90`). Nada otorga capacidades a un teacher.
- En la práctica, "estudiantes" y "todos los que no son admin" son lo mismo: las rutas de schedule solo usan `fastify.authenticate` (`modules/schedule/schedule.routes.ts`), y las comprobaciones de "student not found" solo excluyen `role === "admin"` (`series.service.ts:51`, `admin.service.ts:103,149,610,705,719`). Por lo tanto, una cuenta de teacher puede tratarse como un estudiante reservable.
- Impersonación: `POST /admin/students/:id/impersonate` firma un access token con el rol propio del objetivo y sin claim de impersonador (`admin.service.ts:145-152`). `app.audit_logs` existe en el schema, pero nada escribe en ella (`rg auditLogs` fuera de `db/schema` no devuelve nada).
- Control de acceso del campus: `app/middleware/auth.ts` (token en localStorage, `fetchMe`) y `app/middleware/admin.ts` (`user.role !== 'admin'` -> `/dashboard`). `useSession.ts` tipa el rol como `'user' | 'admin'`. La navegación es un interruptor binario admin-vs-estudiante (`layouts/default.vue:23`). El login lleva a los admins a `/admin/orders` y a los estudiantes a `/dashboard`.

### 2.3 Scheduling y créditos

- `scheduling.weekly_slots` (teacher_id, day_of_week, start/end como texto `HH:MM`), `availabilities` (slots puntuales heredados, teacher_id), `blocked_slots` (teacher_id, `source` manual|caldav, `external_key`), `bookings`, `booking_series`, `class_credits`, `class_notes`, `mentoring_requests` (`db/schema/scheduling.ts`).
- `bookings` NO tiene `teacher_id`. Al profesor solo se llega mediante `weekly_slot_id -> weekly_slots.teacher_id` o `availability_id -> availabilities.teacher_id`.
- Toda consulta de disponibilidad ignora al profesor: `getAvailableSlots` selecciona todos los weekly slots activos (`schedule.service.ts:117`), `checkOccurrenceInTx` bloquea ante CUALQUIER fila de `blocked_slots` (`schedule.service.ts:248`), el `classify` de series carga todos los slots activos y todos los bloqueos (`series.service.ts:56`). El modelo de un solo profesor es una suposición implícita, no una configuración.
- La página pública de mentoría está fijada a un profesor mediante env: `getPublicSlots` filtra `weeklySlots.teacherId = env.mentoring.teacherId` (`modules/portfolio/portfolio.service.ts:141`). `MENTORING_TEACHER_ID` es una variable de entorno obligatoria (`config/env.ts:74`).
- La disponibilidad creada por el admin usa el id del admin autenticado como profesor (`admin.routes.ts:176` para blocked slots), mientras que la sincronización CalDAV escribe bloqueos para `MENTORING_TEACHER_ID` (`calendar-sync/config.ts:49`, `calendar-sync.service.ts:194`). Hoy son la misma persona; divergirían con un segundo profesor.
- `seedMentoring` se ejecuta en CADA arranque mediante `runMigrations()` e inserta, si no existe, una cuenta fija `hola@jesusuzcategui.com` / "Jesus Uzcategui" con id = `MENTORING_TEACHER_ID` (rol por defecto, es decir `user`) y los slots de `mentoring-availability.json` (`db/seed-mentoring.ts:24-58`, copiado a la imagen por el `Dockerfile`).
- Créditos: un único saldo por estudiante, sumado sobre los bloques no vencidos, con vencimiento más próximo primero (`credit-balance.ts`, `schedule.service.ts getStudentCredits`). Los bloques de crédito están vinculados a un producto, no a un profesor.
- La concurrencia de reservas está bien resuelta: `pg_advisory_xact_lock(hashtext('booking-instant:<ms>'))` por instante, con locks en orden ascendente (`schedule.service.ts lockBookingInstant`), `FOR UPDATE` sobre los bloques de crédito, y actualización protegida `used_credits < total_credits`. Esta es la parte que debe preservarse intacta.
- Política/localización fijadas en código: lógica de offset de `America/Bogota` y literales `-05:00` en la generación de slots (`schedule.service.ts`, `series.ts`), corte de cancelación del estudiante de 24 h en dos lugares (`schedule.service.ts:669,783`, `series.service.ts:32`), bloques de slots de 1 hora, asunto del correo de admin en español, resumen de evento "Clase — English", dominio de UID `@vanjex.dev` y `PRODID -//Hub Vanjex//EN` (`schedule.service.ts buildIcal`), URL de Jitsi `https://talk.jesusuzcategui.com/<id>` fija en `portfolio.service.ts:328` mientras que las reservas de clases usan `env.jitsi.baseUrl`.

### 2.4 Efectos secundarios posteriores al commit hoy (el objetivo de la Fase 1)

Cada uno de estos se ejecuta inline en la petición, después del commit a la DB, envuelto en un try/catch que solo registra en el log. Si el proceso muere entre el commit y el efecto secundario, o el proveedor está caído, el efecto secundario se pierde sin registro ni reintento.

| # | Dónde | Efectos secundarios (todos inline, secuenciales) |
|---|---|---|
| 1 | `schedule.service.ts createStudentBooking` (~522-640) | CalDAV PUT (+ UPDATE `gcal_event_id`), correo al estudiante con adjunto `.ics`, correo de notificación al admin (`notifyAdminsOfBooking`) |
| 2 | `schedule.service.ts cancelStudentBooking` (~695) | CalDAV DELETE, solo `if (booking.gcalEventId)`. Sin correo al estudiante |
| 3 | `schedule.service.ts rescheduleBookingInternal` (~730-770) | llama al #1 para la nueva reserva, luego cambio de estado no transaccional de la anterior, liberación de disponibilidad, CalDAV DELETE del evento anterior |
| 4 | `series.service.ts createSeries` (~227-275) | por cada reserva creada (hasta `MAX_SERIES_OCCURRENCES = 50`, `series.ts:14`): un CalDAV PUT, esperado en secuencia, más un `UPDATE gcal_event_id`; luego un correo resumen. SIN notificación al admin (a diferencia del #1) |
| 5 | `series.service.ts cancelSeries` (~406-445) | por cada reserva cancelada un CalDAV DELETE (secuencial), luego un correo |
| 6 | `admin.service.ts cancelBooking` (~280-320) | CalDAV DELETE, correo de cancelación al estudiante |
| 7 | `admin.service.ts deactivateWeeklySlot` (~500-530) | un bucle secuencial con un correo por cada reserva futura afectada |
| 8 | `admin.service.ts createCheckoutLink` (~1007) y `cart.service.ts sendCartLinkEmail` (~125) | correo con el enlace de pago |
| 9 | `payments.service.ts applySettlementSideEffects` (485-730) | otorgamiento de créditos, otorgamiento de acceso a contenido, cambio de estado de fulfillment (NO envuelto en una sola transacción), inserción de token de establecer contraseña + correo de confirmación (636), `fetch` a Umami (650), contador de canje de cupón, más correo `notifyAdminsOfReviewNeeded` (713; también invocado desde `review-verification.service.ts:115`) |
| 10 | `portfolio.service.ts` solicitud pública de mentoría (~340-420) | CalDAV PUT, correo al admin a la dirección fija `hola@jesusuzcategui.com`, correo al cliente con `.ics` |
| 11 | `contact.service.ts sendContactEmail` | un correo inline a una dirección fija; el controlador devuelve HTTP 500 si SMTP falla (`contact.controller.ts`) |
| 12 | `auth.service.ts requestPasswordReset` (~164) | inserción de token + correo inline; retorna temprano ante un email desconocido, por lo que el tiempo de respuesta difiere entre direcciones registradas y no registradas (un canal lateral de temporización, observable desde el código) |
| 13 | `plugins/reminders.ts` + `reminders.service.ts` | cron, no posterior al commit: reclamo atómico (`UPDATE ... SET flag = now WHERE id = $1 AND flag IS NULL RETURNING id`) y luego SMTP inline; ante un fallo se limpia el reclamo para que el siguiente tick reintente, acotado por la ventana del recordatorio |

Observaciones relevantes para el diseño:
- El cliente CalDAV no tiene timeout de petición (`plugins/caldav.ts` usa `fetch` directo). Un Nextcloud lento bloquea la petición todo el tiempo que permita la pila TCP.
- `createEvent` envía `If-None-Match: *` (`plugins/caldav.ts:30-37`) y lanza error ante cualquier respuesta no 2xx, por lo que un PUT cuya respuesta se perdió y que se reintenta recibe 412 y falla para siempre. Cualquier diseño con reintentos debe tratar esto explícitamente.
- La cancelación decide si eliminar el evento del calendario a partir de `bookings.gcal_event_id`, que solo se establece DESPUÉS de que el PUT retorna. Una cancelación que compite con una creación lenta omite entonces el DELETE y deja un evento huérfano. Hoy esa ventana es la duración completa de la petición; con una cola pasa a ser de segundos a minutos, por lo que el orden debe diseñarse (sección 5.6).
- El UID del evento es determinista: el id de la reserva (URL `<CALDAV_URL>/<bookingId>.ics`, `UID:<bookingId>@vanjex.dev`). El lector de calendar-sync omite los eventos con ese sufijo de UID para que una clase nunca se bloquee a sí misma (`calendar-sync/ics.ts:10`). Este acoplamiento debe sobrevivir al puerto CalendarProvider.
- Reportado por el propietario: una sola reserva tardó 6,7 s de extremo a extremo. No medido por mí. Con 50 ocurrencias el bucle secuencial de PUT del #4 escala linealmente, lo que explica los timeouts del navegador/túnel (la UI muestra un error aunque la reserva se confirmó).
- `schedule.routes.ts` ya devuelve 201 para `/schedule/book` y `/schedule/series`, pero solo después de que terminan los efectos secundarios.

### 2.5 CalDAV / Nextcloud

- Lado de escritura: `plugins/caldav.ts`, decorado como `fastify.caldav` con `createEvent(uid, ical)` / `deleteEvent(uid)`, configurado desde las variables de entorno globales `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD` (obligatorias en `config/env.ts`). Se invoca directamente desde `schedule.service.ts`, `series.service.ts`, `admin.service.ts`, `portfolio.service.ts` (4 módulos, 8 puntos de llamada).
- Lado de lectura: `modules/calendar-sync/*` ejecuta un CalDAV REPORT cada 5 minutos, parsea ICS y refleja el tiempo ocupado en filas de `blocked_slots` con `source = 'caldav'` para `MENTORING_TEACHER_ID`. Lee su configuración de forma perezosa desde `process.env` (no desde el `config/env.ts` congelado) para que los tests puedan apuntar a un servidor falso (comentario de cabecera de `calendar-sync/config.ts`). El estado de las ejecuciones de sync está en memoria por proceso (`calendar-sync.service.ts lastRun`).
- Convención de flags (reutilizada en la Fase 1): `calendarSyncEnabled(vars)` = false bajo `NODE_ENV=test`, y en caso contrario activo salvo que `CALDAV_SYNC_ENABLED=false`; el script `pnpm dev` fuerza los flags a false (scripts `dev`, `dev:once` de `package.json`). `remindersEnabled` y `paymentVerificationEnabled` tienen la misma forma.
- Los endpoints de ejecución manual existentes siguen un patrón: `POST /admin/reminders/run`, `POST /admin/calendar-sync/run` (`admin.routes.ts:191,501`). La Fase 1 lo reutiliza.

### 2.6 Pagos, productos, entitlements

- Los pedidos/intentos de pago/eventos viven en el schema `payments`, respaldados por el paquete congelado `hexagonal-payments-core` fijado al git tag `v0.1.2` (dependencia privada de GitHub, `package.json`; el `Dockerfile` necesita el build arg `GH_TOKEN` para instalarlo). Proveedores: ePayco, PayPal, transferencia manual (`adapters/payments/*`). Los tipos de pedido (order kinds) se registran en `OrderKindRegistry`; hoy existe un solo tipo, `class_credit_plan` (`modules/payments/kind-registry.ts`).
- El fulfillment está fijado a créditos: `applySettlementSideEffects` solo otorga cuando `metadata.productId && metadata.creditsCount` (`payments.service.ts:~516`).
- Los productos se sincronizan desde WordPress (`lib/wp.ts`, `modules/products/products.service.ts`; post type de WP `nodus_product`, webhook `POST /webhooks/wp` protegido por `X-Webhook-Secret`, `POST /admin/products/sync` manual). `mapWpItem` OMITE cualquier producto de WP cuya metadata no tenga un entero positivo `creditsCount` (`lib/wp.ts mapWpItem`). Hoy un curso (sin créditos) no puede entrar al catálogo.
- Entitlements: `ecommerce.content_access` (user, content_type, external_id, reason order|subscription, order_id, valid_from/until, revoked_at; índices únicos parciales) con `checkContentAccess` / `grantContentAccess` (`modules/content-access/*`), expuestos en `GET /access/check`, `GET /access/my`. Actualmente se escribe en cada compra de créditos y nada en el campus lo lee, según lo que encontré (no verificado en el código del campus).
- `products.metadata.validityDays` determina el vencimiento de los créditos (`resolveGrantExpiry`, `credit-balance.ts`).

### 2.7 Mailer

`plugins/mailer.ts` expone un `Transporter` de nodemailer configurado desde variables de entorno `SMTP_*`. No hay capa de plantillas más allá de `lib/email-template.ts renderEmailHtml` y los constructores por funcionalidad (`schedule/student-emails.ts`, `reminders.ts`). El locale es `es | en` por cuenta (`accounts.locale`), con algunos textos fijados en español sin importar el locale (aviso de reserva al admin, alerta de revisión, restablecimiento de contraseña, enlace de carrito).

### 2.8 Consistencia del contrato HTTP

Coexisten dos envelopes de error: `{ error: { code, message, details? } }` de `AppError` (`lib/errors.ts`) y `{ error: "text" }` (p. ej. `schedule.routes.ts` para `/schedule/book`, `/schedule/my/:id`, reschedule, el controlador de contact). No hay versionado por URL ni OpenAPI. Los orígenes de CORS son un array en código más dos variables de entorno (`app.ts`). Los conectores públicos necesitarán un contrato estable y documentado; esto se señala en las Fases 3 y 6.

### 2.9 Qué está fijado en código a un solo profesor / CalDAV / env (resumen)

| Elemento fijado en código | Dónde | Pasa a ser |
|---|---|---|
| Un id de profesor | env `MENTORING_TEACHER_ID`; `portfolio.service.ts:141`; configuración de sync; seed | filas por profesor (P3) |
| Un calendario | env `CALDAV_URL/USERNAME/PASSWORD`; `fastify.caldav` | filas de `calendar_connections` + CalendarProvider (P2/P3) |
| Sin profesor en las reservas | schema de `bookings` | `bookings.teacher_id` (P3) |
| Identidad del propietario en textos/destinatarios | `hola@jesusuzcategui.com` x3, host de Jitsi, UID/PRODID `@vanjex.dev`, `America/Bogota`, corte de 24 h | configuración de la instancia en la DB (P3/sección 7) |
| Seed del propietario al arrancar | `seed-mentoring.ts` | configuración de primer arranque (sección 7) |
| Fulfillment solo de créditos | `payments.service.ts`, `lib/wp.ts` | fulfillers por tipo (P5) |
| UI binaria admin/estudiante | middleware y navegación del campus | shell consciente de roles/permisos (P3) |

---

## 3. Visión general de la arquitectura objetivo

Principio: hexagonal. Los módulos de dominio (scheduling, credits, learning, profiles, catalog, notifications) dependen de puertos; los adaptadores los implementan; la infraestructura se conecta en una única raíz de composición. Los efectos secundarios durables pasan por un único outbox (bandeja de salida transaccional).

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

Resumen de puertos (introducidos donde se indica):

| Puerto | Hoy | Adaptador(es) | Fase |
|---|---|---|---|
| `JobQueue` (lado de encolado) + `JobRunner` (lado de consumo) | ninguno | outbox en Postgres; más adelante un relay de outbox a BullMQ | P1 |
| `CalendarProvider` | `fastify.caldav` + `calendar-sync` | CalDAV; Google; Outlook | P2, P7 |
| `Mailer` | `fastify.mailer` (nodemailer) | SMTP; más adelante proveedores por API | P1 (wrapper delgado) |
| `CatalogSource` | `lib/wp.ts` | WordPress; Shopify; manual | P5/P6 |
| `VideoProvider` | ninguno | Bunny, embed externo, Mux, Vimeo, self-host | P5 |
| `MeetingLinkProvider` | construcción inline de la URL de Jitsi | Jitsi; plantilla de URL fija | P3 (traslado a configuración) |
| payments | `hexagonal-payments-core` | ePayco, PayPal, manual | existe |

Punto importante de honestidad sobre el intercambio de la cola: un outbox transaccional solo es atómico con la escritura de negocio si vive en el MISMO Postgres. BullMQ/Redis no puede unirse a la transacción de la reserva. Por lo tanto, "cambiar a BullMQ más adelante" significa cambiar el lado CONSUMIDOR (un relay lee `app.jobs` y publica en BullMQ, los workers consumen desde Redis), mientras la tabla outbox sigue siendo la ruta de escritura durable. La interfaz `JobQueue.enqueue(db, spec)` se mantiene; `JobRunner` es la mitad intercambiable.

---

## 4. Plan de fases

Tamaños: S = unos pocos días, M = 1-2 semanas, L = 3+ semanas, para un ingeniero o agente con revisión. Aproximados, no son compromisos.

| Fase | Objetivo | Depende de | Riesgo | Tamaño |
|---|---|---|---|---|
| P1 | Jobs en segundo plano durables (outbox + worker); las peticiones responden de inmediato | ninguna | Medio: toca todas las rutas posteriores al commit | M |
| P2 | Puerto `CalendarProvider`, CalDAV como primer adaptador | P1 (las llamadas al calendario se ejecutan en jobs) | Bajo | S |
| P3 | Roles + entidad de profesor + conexión de calendario por profesor en la DB; eliminar los valores fijos del propietario | P2 | Alto: cambio de schema en `bookings`, refactor de authz, cambio del shell del campus | L |
| P4 | Skills, perfiles de profesor y de estudiante, matching | P3 | Medio (más diseño de producto que técnico) | M |
| P5 | Cursos pregrabados: catálogo, compra, entitlement, reproductor, progreso | P3 (atribución de instructor), P1 | Medio-Alto: refactor del fulfillment de pagos, elección del proveedor de video | L |
| P6 | Distribución: API pública v1, API keys, webhooks, widgets, plugin de WP, Shopify, Drupal/Joomla, licenciamiento | P3 como mínimo; P5 para los conectores de cursos | Superficie amplia, profundidad baja por conector | L (dividida en 6a-6d) |
| P7 | Adaptadores de Google / Outlook calendar | P2, P3 | Medio (OAuth, verificación de la app) | M cada uno |

### 4.1 Cuestionamientos al orden sugerido

Se mantiene P1 -> P2 -> P3 tal como se propuso, con cuatro ajustes:

1. P2 es muy pequeña (S) y debería comenzar en cuanto existan los handlers de calendario de P1, idealmente dentro del mismo tren de releases. Hacer el puerto antes de que existan los jobs implica refactorizar los puntos de llamada dos veces; hacerlo después es barato porque los handlers son los únicos llamadores que quedan.
2. Agregar una regla de "higiene de contrato" desde P3 en adelante en lugar de una fase: todo endpoint NUEVO usa el envelope `AppError`, el prefijo `/v1` y schemas zod validados y documentados; los endpoints heredados que usan el campus/Astro se mantienen congelados. De lo contrario, la Fase 6 comienza con una reescritura de la API.
3. El orden P4 vs P5 es una decisión de negocio, no técnica (decisión abierta 7). Técnicamente P5 no necesita a P4. Si se planea un curso de pago dentro de aproximadamente tres meses, ejecutar P5 antes de la mitad de matching de P4. Un perfil mínimo de profesor (nombre visible, bio, lista de skills) debería llegar en P3 de todos modos, porque P5 necesita la atribución de "instructor".
4. Los webhooks salientes (P6) vienen casi gratis desde P1: un tipo de job `webhook.deliver` ofrece entrega firmada, reintentos y una vista de dead-letter (cola de mensajes fallidos) sin infraestructura nueva. Esta es la razón principal por la que vale la pena construir primero el outbox. El licenciamiento/activación y la historia del instalador (sin seed del propietario al arrancar, eliminación de la dependencia git privada) son prerrequisitos de P6 y deben planificarse junto con la limpieza de valores fijos del propietario de P3, no descubrirse en P6.

### 4.2 Alcance de las fases y criterios de salida

**P1 - Outbox + worker (especificación en la sección 5)**
- Alcance: tabla `app.jobs`, API de encolado dentro de la transacción, worker en proceso, handlers para cada ruta posterior al commit de 2.4 (#1-#12; el #13 de recordatorios se mantiene como está), endpoints de visibilidad/reintento de jobs para admin, flags, tests.
- Criterios de salida: `POST /schedule/series` con 50 ocurrencias responde 201 en menos de 1 s con CalDAV hecho artificialmente lento a 5 s por llamada; matar el proceso después del commit y antes de que corra el worker sigue produciendo todos los eventos de calendario y correos tras reiniciar; una caída de CalDAV de N minutos no pierde nada; los jobs dead son visibles y reintentables por un admin; `pnpm test` en verde; ningún cambio de comportamiento en el cuerpo de ninguna respuesta salvo los documentados en 5.12.

**P2 - Puerto CalendarProvider**
- Alcance: interfaz (6.1), adaptador CalDAV que envuelve `plugins/caldav.ts` y el lector REPORT, los handlers usan el puerto, calendar-sync usa `listBusy`. Sigue habiendo UNA conexión configurada desde env.
- Salida: ningún módulo fuera de `adapters/calendar/` importa `fastify.caldav` ni hace `fetch` a una URL de calendario; un proveedor falso pasa la misma suite de tests de contrato que el adaptador CalDAV; el comportamiento de `If-None-Match`/412 y los timeouts de petición viven dentro del adaptador.

**P3 - Roles, entidad de profesor, conexión por profesor**
- Alcance: guard de permisos que reemplaza las 4 copias de `requireAdmin`, alias `student` para `user`, tabla de perfil de profesor, `bookings.teacher_id`, disponibilidad con alcance por profesor, tablas `calendar_connections` y `booking_calendar_events`, sync por profesor, shell del campus con tres roles, tabla de configuración de la instancia, eliminación de la dependencia de `MENTORING_TEACHER_ID`/env de CalDAV (se conserva como fallback de arranque durante un release), configuración de primer arranque en lugar del seed.
- Salida: dos profesores con calendarios y disponibilidad separados pueden recibir reservas de forma concurrente; el profesor A no puede leer ni mutar los estudiantes, reservas, notas ni la conexión del profesor B (matriz automatizada de tests entre profesores); el propietario (admin + teacher) trabaja sin cambios; no queda ningún email/dominio/zona horaria del propietario fijado en código en las rutas usadas por un comprador.

**P4 - Skills y perfiles**
- Alcance: taxonomía de skills, perfiles de profesor/estudiante, consulta de búsqueda y matching, pantallas del campus (6.4).
- Salida: un estudiante completa el onboarding con skills/objetivos; un profesor ve el perfil de los estudiantes que reservaron con él; `GET /v1/teachers?skill=` devuelve coincidencias; los flags de privacidad se aplican y se prueban.

**P5 - Cursos**
- Alcance: la fuente de catálogo acepta productos sin créditos, tipo de pedido `course_enrollment` con un registro de fulfillers por tipo, read-model de lecciones sincronizado desde WP, entitlement mediante `content_access`, puerto VideoProvider con un adaptador, autorización de reproducción, progreso, biblioteca y reproductor en el campus.
- Salida: comprar un curso por el checkout existente, recibir el acceso al liquidarse el pago (y manejo de `needs_review` idéntico al de los créditos), verlo con reanudación, revocar ante un reembolso; los usuarios no autorizados no pueden obtener una URL reproducible.

**P6 - Distribución** (6a API v1 + API keys + webhooks salientes + OpenAPI; 6b plugin de WordPress; 6c Shopify; 6d Drupal/Joomla; más licenciamiento/activación y white-label)
- Salida por subfase en 6.6.

**P7 - Google / Outlook**
- Salida: un profesor conecta una cuenta mediante OAuth, se refleja el tiempo ocupado, los eventos se crean/eliminan mediante la misma suite de tests de contrato del proveedor.

---

## 5. Especificación detallada de la Fase 1: jobs durables (outbox transaccional + worker)

### 5.1 Objetivos y no objetivos

Objetivos:
- Una reserva, serie, cancelación o liquidación de pago confirma (commit) su estado de negocio Y su trabajo de seguimiento de forma atómica. La petición HTTP responde justo después del commit.
- El trabajo de seguimiento (CalDAV PUT/DELETE, correos, ping de analytics) se ejecuta en un worker con reintentos, backoff (espera creciente entre reintentos), recuperación ante caídas, orden donde se necesite, idempotencia y visibilidad para el admin.
- Sin cambios de comportamiento para los estudiantes, salvo respuestas más rápidas y los cambios de respuesta documentados en 5.12.

No objetivos (explícitos):
- No se mueven a la cola el cron de recordatorios (`reminders.service.ts`) ni la reverificación de pagos. Ya tienen un reclamo atómico + reintento acotado. Más adelante pueden encolar jobs en lugar de enviar inline; no en esta fase.
- No se introduce Redis/BullMQ. No se construye un dashboard en el campus más allá de lo que 5.9 lista como endpoints (una pantalla del campus es un seguimiento posterior, S).
- No se corrige el reschedule no atómico preexistente (crear el nuevo y luego cancelar el anterior en sentencias separadas) ni la liquidación no transaccional. Se listan como seguimientos en la sección 9.
- No se modifica la lógica de concurrencia de créditos/slots.

### 5.2 Schema

Nueva tabla en el schema `app` existente (junto a `request_logs`, `audit_logs`). La definición de Drizzle va en `db/schema/app.ts`; el SQL es una migración escrita a mano como 0017/0019 (ver 5.13).

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

Semántica de los estados:

| Estado | Significado | Transiciones de salida |
|---|---|---|
| `pending` | esperando `run_at`; también es el estado tras un intento fallido (con `run_at` desplazado por el backoff) | claim -> `running`; cancelación por admin -> `cancelled`; expiración -> `cancelled` |
| `running` | reclamado, con lease (arrendamiento temporal de la fila) vigente (`locked_until`) | éxito -> `succeeded`; fallo reintentable -> `pending`; fallo permanente o intentos agotados -> `dead`; lease vencido -> reaper -> `pending` (o `dead` si se agotaron los intentos) |
| `succeeded` | terminado; se purga tras la retención | terminal |
| `dead` | no volverá a ejecutarse por sí solo; visible para el admin; el endpoint de reintento lo reinicia | reintento por admin -> `pending` |
| `cancelled` | intencionalmente no ejecutado (admin, expirado o reemplazado) | terminal |

Notas:
- "Failed" no es un estado almacenado. Un intento fallido deja la fila en `pending` con `attempts > 0`, `last_error` y un `run_at` futuro. Esto mantiene el índice de claim parcial y diminuto.
- `seq` es una columna identity (no un timestamp), de modo que el orden por grupo es un orden total estricto incluso para jobs insertados en la misma transacción.
- `last_error` almacena la clase del error y un mensaje truncado (<= 500 caracteres) con secretos y direcciones eliminados. Seguir la convención existente en `reminders.service.ts`: registrar ids y `errName`, no PII.
- Sin claves foráneas hacia bookings/orders: la tabla debe aceptar el id de cualquier entidad, y los jobs deben sobrevivir a entidades eliminadas (los handlers tratan "la entidad ya no existe" como un éxito sin efecto).

### 5.3 API de encolado dentro de la transacción

Ubicación: `src/modules/jobs/` (`queue.ts`, `types.ts`, `worker.ts`, `handlers/*.ts`, `jobs.routes.ts`, `backoff.ts`). Schema de Drizzle en `db/schema/app.ts`.

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

- `DbHandle` es el tipo ya exportado desde `modules/schedule/schedule.service.ts` (`PgDatabase<NodePgQueryResultHKT, typeof schema>`), por lo que tanto un `tx` de `fastify.drizzle.transaction(...)` como el pool encajan. `series.service.ts` ya hace un cast del handle de la transacción con `rawTx as unknown as DbHandle`; reutilizarlo.
- La implementación `PgJobQueue` hace UN `INSERT ... ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id` multi-fila por llamada, de modo que una serie de 50 ocurrencias agrega una sentencia a la transacción, no 100. NO está verificado si `onConflictDoNothing({ target, where })` de drizzle acepta el predicado del índice parcial en 0.45; recurrir a `tx.execute(sql\`...\`)` en bruto si no lo acepta.
- `request_id` se toma del id de petición de Fastify cuando está disponible (`req.id`), o null en caso contrario.
- El encolado nunca llama a ningún proveedor y nunca lanza errores por motivos de negocio. Si lanza un error, la transacción envolvente hace rollback y la petición falla honestamente (la reserva no ocurrió).

Forma del punto de llamada (createStudentBooking), reemplazando el bloque posterior al commit:

```ts
await fastify.drizzle.transaction(async (tx) => {
  // ... existing checks, credit charge, insertBookingInTx ...
  await jobQueue.enqueue(tx, bookingCreatedJobs({ bookingId, startsAt, endsAt }));
});
return { bookingId, meetLink, startsAt };   // immediately
```

### 5.4 Tipos de job y payloads

Nomenclatura: `<domain>.<subject>.<action>`. Los payloads (carga útil) llevan solo ids y parámetros pequeños. Los handlers cargan el estado actual al momento de ejecutar, de modo que una entidad cancelada/reprogramada/renombrada se maneje correctamente y el contenido nunca esté desactualizado. Excepciones (formularios públicos sin fila de entidad): llevan el contenido mínimo y se redactan al completarse con éxito (5.14).

Group key = alcance de serialización. Dedupe key = alcance de idempotencia. `expires` = `expires_at`. Valores por defecto: `max_attempts` 8 salvo que se indique otra cosa.

| Type | Payload | Group | Dedupe key | Expires | Reemplaza (2.4 #) |
|---|---|---|---|---|---|
| `calendar.event.create` | `{ subject: { kind: "booking" \| "mentoring_request", id } }` | `cal:<kind>:<id>` | `cal.create:<kind>:<id>` | fin de la clase | 1, 3, 4, 10 |
| `calendar.event.delete` | `{ subject: { kind, id } }` (UID = id, determinista) | `cal:<kind>:<id>` | `cal.delete:<kind>:<id>` | ninguno | 2, 3, 5, 6 |
| `email.booking_confirmed` | `{ bookingId }` (correo al estudiante + `.ics` REQUEST) | `mail:booking:<id>` | `mail.booking_confirmed:<id>` | inicio de la clase | 1 |
| `email.booking_admin_notice` | `{ bookingId }` | ninguno | `mail.booking_admin_notice:<id>` | inicio de la clase | 1 (3 vía 1) |
| `email.booking_cancelled` | `{ bookingId }` | ninguno | `mail.booking_cancelled:<id>` | ninguno | 6 |
| `email.series_confirmed` | `{ seriesId, bookingIds[], creditsUsed, balanceAfter }` | ninguno | `mail.series_confirmed:<seriesId>` | ninguno | 4 |
| `email.series_cancelled` | `{ seriesId, cancelledBookingIds[], keptBookingIds[], creditsRefunded }` | ninguno | `mail.series_cancelled:<seriesId>:<epoch-of-cancel-tx>` | ninguno | 5 |
| `email.weekly_slot_changed` | `{ bookingId }` (un job por reserva afectada) | ninguno | `mail.weekly_slot_changed:<bookingId>:<slotId>` | inicio de la clase | 7 |
| `email.cart_link` | `{ cartId }` | ninguno | ninguna (un reenvío es intencional) | ninguno | 8 |
| `email.payment_confirmed` | `{ orderId }` (el handler crea el token de establecer contraseña al ejecutar) | ninguno | `mail.payment_confirmed:<orderId>` | ninguno | 9 |
| `email.order_needs_review_admin` | `{ orderId, reason }` | ninguno | `mail.order_review:<orderId>:<reason>` | ninguno | 9 |
| `email.mentoring_request_admin` | `{ requestId, locale }` | ninguno | `mail.mentoring_admin:<requestId>` | ninguno | 10 |
| `email.mentoring_request_client` | `{ requestId, locale }` | ninguno | `mail.mentoring_client:<requestId>` | ninguno | 10 |
| `email.contact_form` | `{ name, email, message, projectType, budget }` (no existe fila de entidad) | ninguno | ninguna | ninguno | 11 |
| `auth.password_reset_requested` | `{ email }` (siempre se encola, incluso para un email desconocido; el handler decide) | ninguno | ninguna | 1 h | 12 |
| `analytics.purchase_event` | `{ orderId }` | ninguno | `analytics.purchase:<orderId>` | ninguno; `max_attempts` 3 | 9 |

Notas de diseño por grupo de filas:
- Los jobs de calendario usan el id de la reserva como UID del calendario (ya es así), por lo que DELETE no depende de `bookings.gcal_event_id`. Los puntos de encolado ya no ramifican según `gcalEventId`; siempre encolan el delete y el handler es idempotente (404 = éxito). Esto elimina la condición de carrera del evento huérfano de 2.4.
- `calendar.event.create` para `kind = "booking"`: el handler establece `bookings.gcal_event_id = id` al tener éxito (mantiene el significado actual de la columna y el campo del campus `gcalEventId` devuelto por `listStudentBookings`). En P2/P3 esto pasa a `booking_calendar_events`.
- `auth.password_reset_requested`: siempre se encola después de una entrada con forma de email, de modo que la ruta HTTP hace trabajo idéntico para direcciones conocidas y desconocidas (elimina el canal de temporización de 2.4 #12; la búsqueda y la inserción del token pasan al handler). El token de restablecimiento en bruto se genera dentro del handler y nunca se almacena en el payload ni en la tabla de jobs. Un reintento puede generar un segundo token; el primero sigue siendo válido hasta su TTL de 1 h, lo cual es aceptable.
- `email.payment_confirmed`: mismo principio, el token de establecer contraseña se crea al ejecutar. La inserción en `password_reset_tokens` sale de la ruta de liquidación.
- `email.series_confirmed` lleva `balanceAfter` porque es un valor calculado dentro de la transacción que es costoso/inseguro de recalcular después; todos los demás valores se cargan.
- La dedupe key de `email.series_cancelled` incluye un discriminador por transacción porque una serie puede cancelarse legítimamente por partes a lo largo del tiempo (el estudiante no puede cancelar dentro de las 24 h; el admin cancela el resto después).
- `email.weekly_slot_changed`: reemplaza un bucle secuencial que retiene la petición HTTP durante N envíos SMTP (2.4 #7).
- El incremento del canje de cupón y los otorgamientos de créditos son operaciones de DB, no llamadas a proveedores; permanecen inline en la liquidación para P1 (señalado en la sección 9 como "hacer que la liquidación sea una sola transacción").

Registro de handlers:

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

Reglas de los handlers:
- El primer paso es siempre "cargar el estado actual; si la entidad ya no existe, fue cancelada o superó su relevancia, retornar (éxito sin efecto)". Ejemplos: create-event sobre una reserva con `status = 'cancelled'` retorna sin PUT; los correos de reserva se omiten si la reserva está cancelada (excepto `email.booking_cancelled`); la obsolescencia al estilo de los recordatorios también queda cubierta por `expires_at`.
- Los handlers deben ser seguros de ejecutar dos veces. Calendario: el PUT es idempotente por sobrescritura (UID y contenido deterministas). Correo: al-menos-una-vez; ver 5.7.
- Los handlers reciben su propio `AbortSignal` para la llamada al proveedor. El adaptador CalDAV debe pasar `signal` a `fetch` (hoy no hay ningún timeout).

### 5.5 Bucle del worker

Se ejecuta en el proceso de la API como un plugin de Fastify (`plugins/jobs.ts`), con la misma forma que `plugins/reminders.ts`: registrado en `app.ts`, `dependencies: ["postgres", "mailer", "caldav"]`, iniciado en un hook `onReady` y detenido en `onClose`. Como el claim es SQL puro, extraerlo más adelante a un punto de entrada `worker.ts` separado no requiere cambios de diseño.

Parámetros (leídos de forma perezosa desde `process.env` en `modules/jobs/config.ts`, por la misma razón que `calendar-sync/config.ts`: los tests deben poder sobrescribirlos sin reimportar el `config/env.ts` congelado):

| Env | Por defecto | Significado |
|---|---|---|
| `JOBS_ENABLED` | true (ver 5.10) | interruptor general del bucle del worker (el encolado siempre funciona) |
| `JOBS_POLL_MS` | 1000 | intervalo de sondeo en reposo |
| `JOBS_BATCH_SIZE` | 10 | máximo de filas reclamadas por sentencia |
| `JOBS_CONCURRENCY` | 4 | máximo de handlers en ejecución simultánea |
| `JOBS_LEASE_MS` | 120000 | duración del lease; debe superar el timeout del handler |
| `JOBS_HANDLER_TIMEOUT_MS` | 30000 | abort por handler |
| `JOBS_SHUTDOWN_GRACE_MS` | 8000 | espera de los jobs en ejecución al apagar |
| `JOBS_RETENTION_DAYS` | 14 | retención de succeeded/cancelled; dead se conserva 90 días |
| `DB_POOL_MAX` | (nuevo) 20 | aumenta el tamaño del pool de `pg` para que el worker y HTTP no se bloqueen mutuamente |

Bucle (por proceso):

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

Justificación de la cadencia: un sondeo de 1 s sobre un índice parcial que solo contiene filas ejecutables tiene una carga despreciable y acota la latencia entre el encolado y el inicio en aproximadamente 1 s. `LISTEN/NOTIFY` podría reducirla a casi cero, pero requiere una conexión dedicada y lógica de reconexión; se aplaza (sección 9).

Justificación de la concurrencia: 4 handlers con `DB_POOL_MAX` 20 dejan margen para HTTP. La limitación específica por proveedor (p. ej. 1-2 PUT de CalDAV concurrentes por Nextcloud) corresponde al adaptador de P2, no a esta capa. El orden por grupo ya serializa el trabajo por reserva.

#### 5.5.1 Claim (reclamo)

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

- Es la misma idea que el claim de los recordatorios (`UPDATE ... WHERE flag IS NULL RETURNING id`, solo puede continuar quien recibe la fila de vuelta en su UPDATE) generalizada a lotes con `FOR UPDATE SKIP LOCKED`: dos workers (o dos instancias de la API) nunca reciben la misma fila.
- `attempts` se incrementa EN EL CLAIM, de modo que un job que tumba el proceso cada vez no puede repetirse indefinidamente (protección contra poison pill, mensaje venenoso): tras `max_attempts` claims pasa a dead aunque ningún handler haya retornado jamás.
- Orden por grupo dentro de una sola sentencia: los jobs posteriores de un grupo quedan excluidos porque sus hermanos anteriores siguen `pending` en el snapshot de la sentencia, de modo que como máximo se reclama la cabeza de cada grupo por llamada. Un job anterior `dead` o `cancelled` de forma permanente NO bloquea (solo bloquean `pending`/`running`), por lo que un create muerto nunca traba el cancel que le sigue. Un create `pending` en espera por backoff SÍ bloquea a su delete; ese es el orden buscado.
- Drizzle puede expresar `FOR UPDATE ... SKIP LOCKED` en selects (`.for("update", { skipLocked: true })`, no verificado para 0.45), pero la combinación NOT EXISTS + UPDATE...FROM es más limpia como una única sentencia en bruto mediante `db.execute(sql...)`.
- Jobs expirados: antes de ejecutar, el worker comprueba `expires_at < now()` y marca la fila como `cancelled` con `last_error = 'expired'` (sin invocar al handler).

#### 5.5.2 Finalización y fallo (con fencing)

Todas las escrituras de finalización están condicionadas a que se siga poseyendo el lease, reflejando el patrón "limpiar el reclamo solo si todavía es nuestro" de `reminders.service.ts`:

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

Si el UPDATE con guarda afecta 0 filas, el lease se perdió (fue recuperado por el reaper y posiblemente reclamado de nuevo) y el resultado tardío se descarta con un log `warn`. Los handlers idempotentes hacen inofensiva la posible doble ejecución.

#### 5.5.3 Lease, visibility timeout y recuperación ante caídas

- La duración del lease es de 120 s por defecto y el timeout del handler de 30 s. Sin heartbeat en P1; si algún handler futuro necesita legítimamente más tiempo, darle un `timeoutMs` mayor y hacer que el worker establezca `locked_until = now() + timeoutMs + margin` en el claim (lease por tipo), en lugar de agregar heartbeats.
- Reaper (cada 30 s y una vez al arrancar):

```sql
UPDATE app.jobs
SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
    run_at = now(), locked_by = NULL, locked_until = NULL,
    last_error = 'lease expired (worker crashed or timed out)', last_error_at = now(), updated_at = now()
WHERE status = 'running' AND locked_until < now()
RETURNING id, type, attempts, status;
```
- Resultado: con un kill -9 a la API a mitad de un job, en un máximo de lease + 30 s otro tick (o el proceso reiniciado) retoma el job. Una caída durante un PUT es segura porque el PUT es idempotente; una caída después de que SMTP aceptó pero antes del UPDATE de éxito produce como máximo un correo duplicado (5.7).
- El arranque no ejecuta el reaper a ciegas de inmediato: solo recupera las filas cuyo lease ya venció, de modo que un despliegue gradual (rolling deploy) con dos instancias nunca roba trabajo vivo.

#### 5.5.4 Reintento, backoff y dead letter

Backoff tras el intento `n` (n = valor de `attempts` después del claim): `delay = min(30 s * 4^(n-1), 6 h)`, luego +/-20% de jitter (variación aleatoria; RNG inyectable para los tests).

| Tras el intento | Retraso base | Acumulado (aprox.) |
|---|---|---|
| 1 | 30 s | 30 s |
| 2 | 2 min | 2,5 min |
| 3 | 8 min | 10,5 min |
| 4 | 32 min | 43 min |
| 5 | 2 h 8 min | 2 h 50 min |
| 6 | 6 h (tope) | ~9 h |
| 7 | 6 h | ~15 h |
| 8 | -> dead | |

Por lo tanto, el valor por defecto `max_attempts = 8` tolera aproximadamente una caída de 15 horas del proveedor. Sobrescrituras por tipo: `analytics.purchase_event` 3; `auth.password_reset_requested` 5 (de todos modos expira a la 1 h); todo lo demás 8.

Clasificación de errores (en `classifyError`, pura y con tests unitarios):
- Éxito (no es un error): CalDAV 412 en create (el evento ya existe), 404/204 en delete.
- Reintentable: errores de red, timeouts/aborts, HTTP 5xx, 408, 423, 429, SMTP 4xx / errores de conexión.
- Permanente (`PermanentJobError`, directo a `dead`): HTTP 400, 404 en create, 409, 410, 415, 422; rechazos SMTP 5xx de destinatario/envelope (dirección inválida); payload malformado (fallo de parseo de zod); tipo de job desconocido.
- Los 401/403 de un proveedor son reintentables con el backoff normal (un problema de credenciales puede ser corregido por el admin dentro de la ventana de ~15 h) pero se muestran por separado en `stats` como `authFailures`.
- Dead letter = `status = 'dead'`: permanece en la tabla con `last_error`, es devuelto por el listado de admin, se cuenta en las estadísticas y puede reintentarse (5.9). Opcional (desactivado por defecto): cuando un job pasa a dead, enviar UNA alerta SMTP directa con throttling al buzón del admin (no como job, para evitar bucles), reutilizando la semántica de `env.campus.adminNotificationEmail`; limitar en memoria a 1 por hora.

#### 5.5.5 Retención

Diariamente a las 03:30 UTC (node-cron, el patrón de `autoPurge`): eliminar `succeeded` y `cancelled` con más de `JOBS_RETENTION_DAYS` (14 por defecto), y `dead` con más de 90 días, en lotes de 1000 para mantener los locks cortos. Las dedupe keys se liberan junto con la fila, por lo que un re-encolado muy tardío después de la retención se ejecutaría de nuevo; es aceptable porque los puntos de encolado están ligados a la transacción de eventos de negocio recientes.

### 5.6 Requisitos de orden

| Necesidad | Mecanismo |
|---|---|
| El delete no debe ejecutarse antes del create del mismo evento (cancelar justo después de reservar) | mismo `group_key = cal:<kind>:<id>`; el claim bloquea el `seq` posterior hasta que el anterior esté `succeeded`/`dead`/`cancelled` |
| Create después de que la reserva ya fue cancelada | el handler de create carga la reserva, ve `cancelled` y no hace nada (defensa en profundidad más allá del agrupamiento) |
| Cancelación encolada mientras el create nunca comenzó | optimización opcional en la transacción de cancelación: `cancelPending(['cal.create:booking:<id>', 'mail.booking_confirmed:<id>', 'mail.booking_admin_notice:<id>'])` y luego encolar igualmente el delete solo si el create tenía `attempts > 0`; efecto neto: una reserva cancelada dentro de un segundo no genera tráfico de calendario ni correo de "confirmada". Recomendada, pequeña. |
| Correo de confirmación vs correo de cancelación de la misma reserva | grupo `mail:booking:<id>` en el confirmado; el handler de cancelación también omite el confirmado si está cancelada |
| Reschedule: create del nuevo evento vs delete del evento anterior | reservas independientes, grupos independientes; no se necesita orden |
| Serie: N creates | N jobs independientes, cada uno con su propio grupo y reintento; un PUT que falle no detiene a los demás |

### 5.7 Idempotencia

Capas:
1. Idempotencia de encolado: índice único parcial en `dedupe_key`; `ON CONFLICT DO NOTHING`. Los envíos dobles y las transacciones reintentadas no pueden crear jobs duplicados.
2. Idempotencia del handler hacia el proveedor:
   - Calendar create: UID y cuerpo deterministas; usar un PUT que sobrescribe. Cambio respecto a hoy: eliminar `If-None-Match: *` en el adaptador o tratar el 412 como éxito. Decisión: tratar el 412 como éxito Y mantener el header, para preservar la guarda de "no pisar un evento ajeno con el mismo UID" sin costo. Calendar delete: 404/204 son éxito (ya es así).
   - Correo: SMTP es al-menos-una-vez por naturaleza. El wrapper establece `Message-ID: <job-<id>@<from-domain>>` para que una entrega duplicada lleve el mismo Message-ID (muchos clientes y gateways la colapsan). El UPDATE de éxito sigue inmediatamente a la aceptación de SMTP. La ventana de duplicado = caída entre esas dos sentencias; aceptada y documentada.
3. Idempotencia de negocio: los handlers vuelven a leer el estado, por lo que las ejecuciones tardías/duplicadas después de una cancelación no tienen efecto.

### 5.8 Apagado ordenado (graceful shutdown)

Hoy nada conecta las señales con `app.close()` (verificado, 2.1). Cambio requerido en `server.ts` (pequeño): registrar manejadores de `SIGTERM` y `SIGINT` que llamen a `app.close()` una sola vez.

Al cerrar (hook `onClose` del plugin de jobs):
1. Establecer `stopping = true`: sin nuevos claims.
2. Esperar a los handlers en ejecución hasta `JOBS_SHUTDOWN_GRACE_MS`. Los contenedores se detienen con un período de gracia por defecto de 10 s en Docker; mantener esto en 8 s, o establecer `stop_grace_period` en compose/Coolify y aumentarlo.
3. Pasado el período de gracia, abortar los handlers restantes mediante su `AbortSignal` y liberar sus leases: `UPDATE ... SET status='pending', run_at=now(), locked_by=NULL, locked_until=NULL, attempts = attempts - 1 WHERE locked_by=$me AND status='running'` (un abort por apagado no debe consumir un intento). Si el proceso es terminado antes de eso, el reaper recupera las filas después de que venza el lease.
4. Luego se cierra el pool (hook existente del plugin de postgres). El orden de registro de plugins debe mantener que el `onClose` del plugin de jobs se ejecute antes que el del pool: se espera que Fastify/avvio ejecute los hooks `onClose` en orden inverso de registro (no verificado; agregar un test que verifique que el worker se detiene antes de que el pool termine). `jobs` depende de `postgres`, por lo que se registra después y debería cerrarse primero.

### 5.9 Visibilidad para el admin y reintento

Nuevas rutas en `modules/jobs/jobs.routes.ts`, protegidas por la comprobación de admin (usar la copia existente de `requireAdmin` en P1; reemplazada por el guard de permisos en P3). Los payloads nunca se devuelven en las respuestas de listado; la vista de detalle enmascara las direcciones de email con el helper existente `maskEmail` (`schedule/reminders.ts:96`).

| Método y ruta | Propósito |
|---|---|
| `GET /admin/jobs?status=&type=&limit=&cursor=` | listado paginado (id, type, status, attempts/maxAttempts, run_at, last_error, last_error_at, created_at, finished_at) ordenado por `seq desc` |
| `GET /admin/jobs/stats` | conteos por estado y tipo; antigüedad del pending más viejo (lag de la cola); cantidad de dead; contadores de `authFailures` desde el arranque; última purga; flag de worker habilitado, concurrencia, id del worker |
| `GET /admin/jobs/:id` | detalle incl. payload enmascarado |
| `POST /admin/jobs/:id/retry` | solo `dead` o `cancelled(expired)`: establece `status='pending', attempts=0, run_at=now(), last_error=NULL`. No hace falta re-encolar una dedupe key obsoleta porque se reutiliza la misma fila |
| `POST /admin/jobs/:id/cancel` | solo `pending` -> `cancelled` |
| `POST /admin/jobs/run` `{ limit?: number }` | una pasada manual de drenaje dentro de la petición (mismo patrón que `POST /admin/reminders/run`, `POST /admin/calendar-sync/run`); la única forma de que se ejecuten jobs cuando el worker está deshabilitado en desarrollo local |

Retry/cancel escriben una fila en `app.audit_logs` (`action = 'job.retry'|'job.cancel'`, `actor_id`, `target_id`, `target_type = 'job'`). Este es el primer escritor de esa tabla hoy sin uso; ya está en el schema, por lo que no hace falta migración.

### 5.10 Flags de configuración (patrón existente)

`modules/jobs/config.ts`:

```ts
export function jobsEnabled(vars: { NODE_ENV?: string; JOBS_ENABLED?: string }): boolean {
  if (vars.NODE_ENV === "test") return false;                       // a test boot can never email anybody
  return (vars.JOBS_ENABLED ?? "true").toLowerCase() !== "false";   // on by default in prod image (no NODE_ENV set)
}
```

- Forma idéntica a `remindersEnabled`, `paymentVerificationEnabled`, `calendarSyncEnabled`.
- Los scripts `dev` y `dev:once` de `package.json` reciben `JOBS_ENABLED=${JOBS_ENABLED:-false}` como los otros tres flags (una laptop con credenciales reales de SMTP/CalDAV no debe disparar efectos secundarios reales por accidente).
- Consecuencia a tener presente: hoy `pnpm dev` SÍ envía correos de reserva inline y PUTs de calendario (los tres flags existentes solo cubren los crons). Con el worker apagado en dev, las reservas locales encolan filas que nada drena hasta `POST /admin/jobs/run` o `JOBS_ENABLED=true pnpm dev`. Es deliberado y consistente, pero es un cambio en la experiencia de desarrollo (decisión abierta 11).
- El encolado nunca está condicionado por el flag, de modo que los tests siempre observan las filas encoladas y la ruta de datos de producción es la que se prueba.
- Bajo `NODE_ENV=test` el worker está apagado; los tests de integración manejan el worker explícitamente mediante `runJobsOnce(deps, options)` exportado (`options.now`, `options.handlers`, `options.rng`), de modo que el tiempo y los proveedores se inyectan, como en `runReminderPass(fastify, { now })`.

### 5.11 Cómo migra el código inline existente sin cambiar el comportamiento

Principio: MOVER el código, no reescribirlo. Para cada punto de llamada:
1. Extraer el cuerpo del try/catch inline a una función handler con la misma lógica (p. ej. `sendBookingConfirmation(ctx, bookingId)` que contiene el código existente de `buildBookingConfirmedEmail` + adjunto `.ics`; el cuerpo de `notifyAdminsOfBooking` sin cambios).
2. Reemplazar el bloque inline por `enqueue(tx, ...)` dentro de la transacción existente (para #1/#4/#5/#6 la transacción ya existe; para #2/#3/#7/#8-#12 envolver el cambio de estado y el encolado en una transacción corta).
3. Mantener los constructores de correo, el constructor de ICS y los asuntos tal como están (incluido el asunto en español para el admin; la localización es P3/sección 7, no aquí).
4. Los constructores puros conservan sus tests unitarios (`student-emails.test.ts`, etc.).

Lista de verificación por punto de llamada (cada uno es un paso del tamaño de un commit/PR, en el orden de despliegue de 5.15):

| # | Cambio |
|---|---|
| 1 `createStudentBooking` | en la tx: encolar `calendar.event.create`, `email.booking_confirmed`, `email.booking_admin_notice`; eliminar la consulta del nombre del producto y los envíos inline posteriores a la tx (los handlers cargan producto y estudiante). El valor de retorno no cambia |
| 4 `createSeries` | en la tx: un encolado multi-fila de N `calendar.event.create` + 1 `email.series_confirmed` (`bookingIds`, `creditsUsed`, `balanceAfter`). Eliminar el bucle secuencial y la consulta `inArray(products...)` posterior al commit. NO se agrega aviso al admin (preserva el comportamiento actual; señalado como posible brecha de producto en 5.16) |
| 5 `cancelSeries` | en la tx tras los reembolsos: encolar N `calendar.event.delete` (siempre, sin ramificación por `gcalEventId`) + `email.series_cancelled` (solo si `cancelled.length > 0`, como hoy) |
| 2 `cancelStudentBooking` | envolver las sentencias update existentes más el encolado de `calendar.event.delete` en la transacción existente (ya es una tx) |
| 6 `cancelBooking` de admin | igual, más `email.booking_cancelled` |
| 3 reschedule | nueva reserva mediante #1 (encola sus propios jobs); después de que la cancelación condicional existente de la anterior tenga éxito, encolar `calendar.event.delete` para el id de la reserva anterior en una tx corta junto con la liberación de disponibilidad. La estructura no atómica se mantiene tal cual |
| 7 `deactivateWeeklySlot` | misma transacción que la actualización del slot: encolar un `email.weekly_slot_changed` por cada reserva afectada; `notifiedBookings` ahora significa "encolado" |
| 8 enlace de carrito / enlace de checkout | encolar `email.cart_link` después de que exista la fila del carrito (una tx corta o la misma) |
| 9 liquidación | encolar `email.payment_confirmed`, `analytics.purchase_event` y, donde corresponda, `email.order_needs_review_admin` en lugar de inline; el otorgamiento de créditos, el acceso a contenido, el cambio de estado de fulfillment y el incremento de cupón permanecen inline en P1 |
| 10 solicitud de mentoría | en la tx existente tras el insert: encolar `calendar.event.create (mentoring_request)`, `email.mentoring_request_admin`, `email.mentoring_request_client`. `locale` va en el payload (hoy no se almacena en la fila) |
| 11 contact | encolar `email.contact_form`; el controlador devuelve `{ ok: true }` tras el encolado |
| 12 restablecimiento de contraseña | encolar `auth.password_reset_requested { email }` y retornar; la búsqueda/token/correo pasan al handler |

Los handlers envuelven las llamadas a proveedores mediante dos gateways delgados que existen solo en P1 y son reemplazados por el puerto de P2: `CalendarGateway` (delega en `fastify.caldav`, agrega el timeout/`signal`, trata el 412 en create como éxito) y `Mailer` (delega en `fastify.mailer`, agrega `Message-ID`). Esto mantiene P1 pequeña y hace de P2 una sustitución pura.

### 5.12 Respuestas HTTP después de la Fase 1

| Endpoint | Antes | Después |
|---|---|---|
| `POST /schedule/book` | 201 tras CalDAV + 2 correos | 201 justo después del commit; mismo cuerpo `{ data: { bookingId, meetLink, startsAt } }` |
| `POST /schedule/series`, `POST /admin/students/:id/series` | 201 tras N PUT secuenciales + correo | 201 justo después del commit; mismo cuerpo |
| `DELETE /schedule/my/:id`, `PATCH .../reschedule`, cancelación de serie, cancelación por admin | esperan a CalDAV (+ correo) | retornan tras el commit; mismos cuerpos |
| `PATCH /admin/weekly-slots/:id` (desactivar) | `notifiedBookings` = correos efectivamente enviados | mismo campo, valor = correos encolados (cambio semántico documentado) |
| `POST /contact` | 500 cuando SMTP falla | 200 `{ ok: true }` una vez encolado; los fallos de entrega pasan a ser jobs dead visibles. Mejora intencional; cambio de comportamiento visible para el usuario |
| `POST /auth/forgot-password` | tiempo distinto para email desconocido | mismo status/cuerpo; el tiempo ya no depende de la existencia de la cuenta |
| solicitud pública de mentoría | retorna tras PUT + 2 correos | retorna `{ id, startsAt }` justo después del commit |

Nuevo hecho visible para el cliente: los efectos secundarios son eventualmente consistentes (típicamente < 2 s). El campus no debe asumir que `gcalEventId` está establecido en la respuesta 201. El código del campus que leí no parece depender de ello (no verificado exhaustivamente).

### 5.13 Numeración de migraciones y journal

- Archivo: `drizzle/migrations/0020_jobs_outbox.sql` (SQL escrito a mano, sin omitir ningún `-- statement-breakpoint`: cada sentencia separada con `--> statement-breakpoint`, igual que 0017/0019).
- Entrada del journal a agregar en `drizzle/migrations/meta/_journal.json`:

```json
{ "idx": 20, "version": "7", "when": 1791676800000, "tag": "0020_jobs_outbox", "breakpoints": true }
```

  `1791676800000` = `when` anterior (1791590400000, idx 19) + 86.400.000. El migrador de drizzle solo aplica las migraciones cuyo `when` es mayor que el de la última aplicada, por lo que el valor DEBE ser estrictamente mayor que 1791590400000; reutilizar la convención de incremento de un día observada en todas las entradas previas.
- Agregar una definición de tabla de drizzle para `app.jobs` en `db/schema/app.ts` (mantener schema y SQL sincronizados; el repositorio solo tiene un snapshot 0000, por lo que no se necesita ni se confía en la salida de `drizzle-kit generate`).
- Agregar `db/__tests__/migration-0020.test.ts` siguiendo `migration-0017.test.ts`/`0019` (buscar la migración por tag para que migraciones posteriores no lo rompan).
- Sin backfill de datos. Solo aditiva. `repairSchema` en `db/migrate.ts` NO se extiende.

### 5.14 Seguridad y manejo de datos

- `payload` lleva ids; el único contenido en bruto está en `email.contact_form` y `auth.password_reset_requested` (una dirección de email). Al pasar a `succeeded`, un paso de finalización del handler reemplaza esos payloads por `{"redacted":true}` (un booleano en el registro de tipos, `redactOnSuccess`). Los jobs dead conservan el payload hasta la purga (90 días) para que un admin pueda reintentarlos; el endpoint de detalle enmascara las direcciones.
- `last_error` se construye a partir de una lista de permitidos (clase del error, status HTTP, código de respuesta SMTP); nunca cuerpos de respuesta del proveedor, credenciales, URLs con credenciales, títulos de eventos ni contenido de mensajes. Esto sigue la regla explícita de `calendar-sync` ("no response body, credentials, URLs or event titles in logs").
- Los endpoints de admin requieren el control de admin; sin acceso de estudiantes ni profesores en P1.

### 5.15 Despliegue y rollback

Despliegue (cada paso desplegable y reversible de forma independiente):
1. Publicar la migración 0020 + cola + worker + handlers + endpoints de admin con el worker ENCENDIDO en producción pero SOLO con los puntos de llamada de crear/cancelar serie y reserva/cancelación individual migrados (#1, #2, #4, #5, #6). Son los frágiles. Verificar en staging con el test de latencia falsa (criterios de salida) y luego en producción con una serie real.
2. Migrar #3, #7, #8, #12, #11.
3. Migrar #9 (liquidación) y #10 (solicitud pública de mentoría). La liquidación es lo más sensible: hacerlo al final, con un pedido en staging pagado mediante ePayco sandbox/transferencia manual.
4. Agregar los manejadores de señal de `server.ts` junto con el paso 1 (necesarios para un apagado limpio del worker).

Observar entre pasos: `GET /admin/jobs/stats` muestra dead = 0 y lag de la cola < 5 s.

Rollback:
- Código: redesplegar la imagen anterior. La tabla es aditiva y el código antiguo la ignora, por lo que no se requiere rollback de schema.
- Los jobs encolados por la nueva versión permanecen `pending`. Al avanzar de nuevo se drenan (con `expires_at` omitiendo los correos de clases obsoletas). Si se prefiere no ejecutarlos: `UPDATE app.jobs SET status='cancelled', last_error='rolled back' WHERE status='pending' AND type LIKE 'email.%'` (nota: es un paso SQL manual que el propietario debe ejecutar deliberadamente; este documento no ejecuta nada).
- Kill switch sin redespliegue: `JOBS_ENABLED=false` detiene el procesamiento manteniendo el encolado; `POST /admin/jobs/run` drena manualmente.
- No se mantiene una doble ruta de código (inline vs cola) en el repositorio; una doble ruta duplicaría la superficie de bugs. La palanca de rollback es la imagen, no un flag.

### 5.16 Plan de tests

Se aplica TDD estricto (configuración del proyecto): primero unidades puras (red/green), luego integración. Los tests con DB siguen la guarda de base de datos descartable del repositorio (`lib/test-db-guard.ts`: el nombre termina en `_it|_test|_rem|_ser`): env `JOBS_IT_DATABASE_URL` apuntando a una DB que termina en `_it`; `describe.skipIf(!DB_URL)` como en `series.integration.test.ts`; los proveedores son siempre falsos (ninguna llamada real a SMTP/CalDAV).

Unitarios (sin DB):
- `backoff.test.ts`: tabla de calendario de 5.5.4, tope, límites del jitter con RNG inyectado.
- `classifyError.test.ts`: cada fila de la lista de clasificación (códigos HTTP, códigos SMTP, abort, 412-en-create-es-éxito).
- `jobsEnabled.test.ts`: las mismas tres aserciones que `remindersEnabled` (activo por defecto, `false` lo desactiva, `NODE_ENV=test` siempre apagado).
- Schemas zod de payload y el registro (tipo desconocido -> permanente).

Integración (DB descartable, proveedor falso + mailer falso con latencia/fallos controlables):
1. Atomicidad: encolar dentro de una transacción que hace rollback no deja ningún job; una que hace commit deja exactamente los jobs esperados (la reserva y los jobs existen ambos o ninguno).
2. Dedupe: encolar dos veces la misma `dedupe_key` devuelve `deduped: true` una vez y una sola fila.
3. Doble claim: insertar 200 jobs, ejecutar 8 claimers concurrentes (conexiones separadas) en bucle hasta drenar; verificar que cada job fue reclamado exactamente una vez (el conjunto de ids coincide, sin duplicados) y `attempts = 1` para todos.
4. Recuperación ante caídas: reclamar un job, nunca completarlo, avanzar el tiempo inyectado más allá de `locked_until`, ejecutar el reaper: el job vuelve a `pending`, `attempts` se preserva; repetir hasta `max_attempts`: termina `dead`. Además: una finalización tardía del worker "caído" es rechazada por el fencing (0 filas) y no sobrescribe el resultado del nuevo dueño.
5. Orden por grupo: create+delete de una reserva: el delete no es reclamable mientras el create está `pending` o `running`; una vez que el create tiene éxito el delete se ejecuta; si el create pasa a `dead` el delete pasa a ser reclamable; un create pending en backoff sigue bloqueando al delete.
6. Reintento/backoff de extremo a extremo: el proveedor falso falla dos veces y luego tiene éxito; verificar que `run_at` sigue el calendario (reloj inyectado), final `succeeded`, `attempts = 3`. Un error permanente va directo a `dead` con `last_error` libre de payload/PII.
7. Expiración: un job pasado de `expires_at` pasa a `cancelled` sin invocar al handler.
8. Velocidad de serie: CalDAV falso con 500 ms de latencia; `createSeries` con 12 ocurrencias retorna con el falso habiendo recibido 0 llamadas; tras drenar, 12 PUT y 1 correo resumen; filas de reservas y de jobs consistentes. Sin aserción basada en tiempo sobre la petición (verificar "proveedor no llamado antes del drenaje" en lugar de un límite de reloj, para evitar flakiness).
9. Carrera cancelar-después-de-reservar: reservar y cancelar de inmediato; tras drenar, no queda ningún evento de calendario (el estado del proveedor falso está vacío) y no se envió ningún correo de "confirmada" si `cancelPending` lo eliminó.
10. Create idempotente: el proveedor falso devuelve 412 en el segundo PUT del mismo UID; el job tiene éxito.
11. Corrección de los no-op de los handlers: reserva cancelada -> el handler de create no hace PUT; reserva eliminada -> sin error.
12. Apagado ordenado: iniciar el worker, comenzar un job lento, llamar a close con una gracia menor que el job; el lease se libera, `attempts` no se consume, otro worker lo termina.
13. Endpoints de admin: autorización de list/stats/detail/retry/cancel/run (user y teacher reciben 403), retry reinicia un job dead, enmascaramiento del payload, fila de auditoría escrita.
14. Test de migración `migration-0020.test.ts`: existen la tabla, los check constraints y los índices parciales; el `when` es mayor que el de 0019.
15. A nivel HTTP: `POST /schedule/series` devuelve 201 con la misma forma de cuerpo que antes (snapshot de claves); contact devuelve `{ ok: true }` con el SMTP falso lanzando error en el momento del encolado, irrelevante para la respuesta.
16. Regresión: las suites existentes (`series`, `reminders`, `credit-balance`, `payment-verification`, `calendar-sync`) pasan sin cambios; los mocks que verificaban llamadas inline a `createEvent`/`sendMail` trasladan sus aserciones a "job encolado" más "el handler hace X al drenar".

### 5.17 Métricas y logging

- Una línea de log estructurada por intento de job: `{ jobId, type, attempt, maxAttempts, outcome: ok|retry|dead|skipped|lease_lost, durationMs, lagMs (start - run_at), errClass }`. Sin payload, direcciones, nombres ni cuerpos del proveedor (misma disciplina que `reminders.service.ts`: solo id de la reserva y `errName`).
- Cada 60 s, si ocurrió algo, una línea de resumen: claimed/succeeded/retried/dead/expired, profundidad de la cola por estado, antigüedad del pending más viejo (el SLI clave: lag entre encolado e inicio).
- `GET /admin/jobs/stats` expone los mismos números bajo demanda. El repositorio no tiene librería de métricas (no hay `prom-client` en `package.json`), por lo que un endpoint de Prometheus es un paso posterior y opcional; el endpoint de stats y los logs cubren el nivel exigido de P1.
- Correlación: `request_id` en la fila enlaza con la línea de log de la petición HTTP (logger de Fastify) y con `app.request_logs` (esa tabla almacena path/status/duración por petición; no tiene columna de id de petición, por lo que la correlación allí es por id de usuario + tiempo, no verificado como suficiente).

### 5.18 Riesgos específicos de la Fase 1

- Sorpresas por consistencia eventual: una UI que esperaba `gcalEventId` de inmediato. Mitigación: documentado en 5.12; el campus no parece depender de ello.
- Cambio de comportamiento en desarrollo (5.10). Mitigación: endpoint de ejecución manual, flag explícito.
- Correos duplicados ante una temporización de caída poco frecuente (5.7). Aceptado; el dedupe por Message-ID lo atenúa.
- Crecimiento de la cola mal acotado durante una caída prolongada. Acotado por `expires_at` para los jobs relacionados con clases y por la retención; las stats exponen el lag.
- `schedule.service.ts` tiene 810 líneas y `payments.service.ts` 1105; las ediciones son quirúrgicas pero el diff de revisión será grande. Dividir según los pasos de despliegue de 5.15 (un PR por paso).

---

## 6. Fases 2-6 con profundidad media

### 6.1 Fase 2: puerto CalendarProvider

Boceto de la interfaz (a nivel de dominio; ningún tipo de CalDAV/ICS se filtra hacia afuera):

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

Notas:
- Taxonomía de errores: los adaptadores lanzan `ProviderTransientError` / `ProviderPermanentError` / `ProviderAuthError`; el `classifyError` de P1 es el único consumidor, de modo que los handlers no cambian.
- Suite de tests de contrato parametrizada sobre los adaptadores (falso en memoria, CalDAV contra el servidor CalDAV falso existente usado por `calendar-sync.integration.test.ts`, más adelante Google/Outlook contra fixtures grabados).
- `ics.ts`/`caldav-report.ts` pasan a `adapters/calendar/caldav/`; `buildIcal` pasa a ser el serializador privado del adaptador CalDAV (el adjunto `.ics` del correo todavía lo necesita; compartirlo mediante una pequeña utilidad `ics`).
- P2 mantiene UNA conexión proveniente de env, de modo que se publica sin cambio de schema.

### 6.2 Fase 3: roles, entidad de profesor, conexión por profesor

**Modelo de roles.** Mantener el enum de Postgres (de todos modos no se pueden eliminar valores de un enum de Postgres). Nomenclatura a nivel de API: `student` es un alias del `user` almacenado; el código nuevo y el JWT usan un helper `roles`, y el `user` heredado sigue funcionando. La capacidad de profesor se deriva de tener una fila activa en `teacher_profiles`, no solo de `role = 'teacher'`, de modo que el propietario (rol `admin`) también pueda ser profesor sin dos cuentas (decisión abierta 3). Los permisos son un mapa definido en código `role/capabilities -> permission strings`, verificado por un único guard `requirePermission("bookings:read:any")` que reemplaza las cuatro copias de `requireAdmin`. Un JWT de profesor lleva `role`; el alcance usa `sub`, nunca un id de profesor suministrado por el cliente.

Matriz RBAC (A = admin, T = teacher, S = student; "own" = filas donde el actor es el dueño; "own students" = estudiantes con al menos una reserva no cancelada con ese profesor o asignados explícitamente):

| Recurso / acción | Admin | Teacher | Student | Notas |
|---|---|---|---|---|
| Cuentas: listar/crear/editar/bloquear/eliminar usuarios | todos | no | no | |
| Cambiar roles, crear profesores | sí | no | no | |
| Impersonar a un usuario | sí (auditado, con claim de impersonador) | no | no | agrega claim `act`; escribe `audit_logs` (P3) |
| Leer/actualizar el propio perfil | sí | sí | sí | |
| Editar perfil de profesor | cualquiera | propio | no | |
| Directorio de profesores (campos públicos) | sí | sí | sí | solo campos públicos |
| Lista de estudiantes | todos | own students | no | |
| PII del estudiante (email, whatsapp) | todos | email + nombre de own students; sin whatsapp salvo que el estudiante lo autorice | propio | |
| Perfil/skills del estudiante | todos | own students si `visible_to_teachers` | propio | P4 |
| Weekly slots / disponibilidad / blocked slots | cualquier profesor | propios | lectura (vía el endpoint de slots) | |
| Conexión de calendario (conectar/verificar/desconectar) | cualquiera (solo ver el estado; los secretos nunca se devuelven) | propia | no | |
| Reservas: listar | todas | propias (por `teacher_id`) | propias | |
| Reservar para un estudiante | sí | own students, slots propios | uno mismo | |
| Cancelar/reprogramar una reserva | cualquiera, sin corte | reservas propias, sin corte de estudiante | propias, corte de 24 h (configurable) | el corte pasa a la configuración |
| Marcar asistencia | cualquiera | reservas propias | no | |
| Notas de clase: escribir | cualquiera | reservas propias | no | |
| Notas de clase: leer | cualquiera | reservas propias | reservas propias | |
| Series: crear/cancelar para un estudiante | cualquiera | own students | uno mismo | |
| Créditos: ver | todos | saldo de own students (lectura) | propio | |
| Créditos: otorgar/ajustar | sí | no | no | |
| Pedidos/pagos/comprobantes/cupones/métodos de pago | sí | no | pedidos propios | los profesores nunca ven datos financieros |
| Productos/sincronización de catálogo | sí | lectura | lectura de activos | |
| Administración de la cola de jobs (P1) | sí | no | no | |
| Estado/conflictos de calendar-sync | todos | propios | no | |
| Cursos: crear/gestionar (P5) | sí | propios (instructor) | no | |
| Cursos: ver / progreso | sí (preview) | sí (preview) | solo con entitlement | |
| Reportes | todos | propios | no | |
| Configuración de la instancia, licenciamiento | sí | no | no | |

Aislamiento de datos por profesor (diseño de referencia):
1. Toda ruta de consulta que devuelve datos propiedad de un profesor recibe un `Actor { id, roles, isTeacher }` y aplica un predicado de alcance desde un único helper (`scopeBookings(actor)`, `scopeStudents(actor)`); los handlers nunca construyen filtros ad hoc. Esta es la guarda a nivel de aplicación.
2. Matriz obligatoria de tests entre profesores: para cada recurso anterior, el profesor B obtiene 403/404 (nunca 200 con datos vacíos que filtren la existencia) sobre los ids del profesor A, en una suite de integración que corre en CI.
3. El row-level security (seguridad a nivel de fila) de Postgres con `SET LOCAL app.actor_id` por transacción es la opción de defensa en profundidad. Costo: cada petición necesita una transacción con `SET LOCAL` y disciplina con las conexiones del pool. Aplazado (la lista de decisiones abiertas no lo necesita para P3; recomendado como endurecimiento posterior cuando exista un segundo profesor real).
4. El admin tiene alcance de toda la instancia por diseño (el comprador). Los profesores no son tenants entre sí; son personal de un mismo negocio.

Boceto del modelo de datos (nombres indicativos; el DDL corresponde a la especificación de P3):

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

Migración de los datos del propietario: un paso único crea la fila de `teacher_profiles` del propietario (id = el `MENTORING_TEACHER_ID` actual), una fila de `calendar_connections` a partir de las variables de entorno `CALDAV_*` actuales, hace el backfill de `bookings.teacher_id` y vincula las filas existentes de `blocked_slots` a la conexión. Las variables de entorno siguen siendo legibles como fallback de arranque durante un release.

Cambios en el campus (alto nivel): navegación dirigida por permisos (reemplazar el interruptor binario de `layouts/default.vue:23`), tipo de rol de `useSession` ampliado, home de profesor (agenda propia, estudiantes propios, disponibilidad, estado de la conexión), páginas de administración con alcance de profesor reutilizadas con scope, aterrizaje del login según el rol.

Convenciones de API desde P3: nuevos endpoints bajo `/v1`, envelope `AppError`, schemas zod, paginación `{ data, nextCursor }`. Los endpoints heredados permanecen congelados hasta que se migre el campus.

### 6.3 Limpiezas previas de la Fase 3 (explícitas para no bloquear P6)

- Reemplazar los strings/direcciones/zona horaria/host de Jitsi del propietario fijados en código por configuración (7.1).
- Reemplazar el `seedMentoring` del arranque por un flujo de configuración de primer arranque (7.3).
- Corregir el tipo `role` del JWT con la unión real; mantener `sub` como la única identidad usada para el alcance.
- Extraer un único `requirePermission` y eliminar las cuatro copias de `requireAdmin`.

### 6.4 Fase 4: skills y perfiles

Modelo de datos:

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

Reglas de la taxonomía: conjunto inicial sembrado por instancia (web full-stack, móvil, nativo, diseño gráfico, ...), los profesores pueden PROPONER una skill (`status = proposed`), el admin aprueba/fusiona (la fusión reescribe las filas de unión y registra `merged_into`). Los objetivos en texto libre siguen siendo texto libre; sin ML.

Matching (SQL determinista, explicable): score = suma sobre (skills `learn` del estudiante intersecadas con las skills del profesor) de `level * priority_weight`, más coincidencia de idioma, más "tiene disponibilidad reservable en los próximos 14 días". Endpoints: `GET /v1/teachers?skill=&language=&q=` (campos públicos, utilizable por widgets de sitios), `GET /v1/students/:id/matches` (teacher/admin). Vínculo con productos: un producto con `product_skills` y `product_teachers` acota la lista de profesores mostrada en el flujo de reserva. Vínculo con disponibilidad: el "próximo slot disponible" se calcula a partir de los weekly slots del profesor menos los bloqueos y reservas, reutilizando las funciones con alcance por profesor de P3.

Privacidad: el perfil del estudiante es visible solo para los profesores con los que reservó (o para todos los profesores si el estudiante lo autoriza); se soporta exportar/eliminar los datos del perfil (necesario para compradores sujetos a leyes de protección de datos; confirmar por mercado, no verificado).

Pantallas del campus (alto nivel):
- Student: asistente de onboarding (objetivos, skills a aprender, skills que ya posee, idioma, zona horaria), página de perfil, directorio de profesores con filtros por skill, flujo de reserva filtrado por el profesor elegido.
- Teacher: editor de perfil (bio por idioma, skills con nivel), lista de "mis estudiantes" con la ficha del estudiante (objetivos/skills/notas), disponibilidad y conexión de calendario.
- Admin: gestor de taxonomía de skills (aprobar, fusionar, renombrar), gestión de profesores.

### 6.5 Fase 5: cursos pregrabados

Principios: WordPress sigue siendo la fuente de verdad del catálogo y de la estructura de lecciones; el hub conserva un read-model más acceso y progreso (el mismo patrón que los productos mediante `lib/wp.ts` + sincronización por webhook).

Catálogo:
- Tipo de contenido de WP `nodus_course` (o un campo `kind` en `nodus_product`) con un repeater de lecciones: title, order, duration, `videoProvider`, `videoRef`, `isPreview`. `mapWpItem` debe dejar de exigir `creditsCount` para productos sin créditos (hoy los omite, 2.6): agregar `productKind = credits | course` y validar por tipo.
- Read-model del hub:

```sql
learning.courses (id uuid PK, product_id uuid UNIQUE REFERENCES ecommerce.products, slug text, status text, instructor_id uuid NULL);
learning.lessons (id uuid PK, course_id uuid, external_id text, position int, title text, duration_s int,
                  video_provider text, video_ref text, is_preview boolean, UNIQUE (course_id, external_id));
learning.lesson_progress (user_id uuid, lesson_id uuid, position_s int, completed_at timestamptz, updated_at timestamptz,
                          PRIMARY KEY (user_id, lesson_id));
```

Compra y fulfillment: reutilizar el flujo existente carrito -> pedido -> pago. Agregar un tipo de pedido `course_enrollment` a `OrderKindRegistry` (el registro ya soporta varios tipos/versiones, `kind-registry.ts`). Refactorizar `applySettlementSideEffects` hacia un registro de fulfillers por tipo (fulfiller de créditos = el código actual; fulfiller de cursos = otorgar acceso). Este refactor es el trabajo real y es también lo que necesitan los pedidos de Shopify/externos en P6.

Entitlement: `ecommerce.content_access` ya lo modela (user, content type/external id, reason order, `valid_until`, `revoked_at`, índice único parcial por pedido, `checkContentAccess`). Acceso a un curso = una fila con el `(content_type, external_id)` del producto del curso. Un reembolso/contracargo lo revoca (`revoked_at`). Acceso con límite de tiempo mediante `valid_until` (el patrón de `products.metadata`, como `validityDays`).

Autorización de reproducción: `POST /v1/learning/lessons/:id/playback` -> verifica `checkContentAccess` (o `is_preview`), luego solicita al `VideoProvider` una URL/token de reproducción firmada de corta duración (5 min); el campus nunca conserva una URL permanente.

```ts
export interface VideoProvider {
  readonly kind: "bunny" | "mux" | "vimeo" | "cloudflare" | "external" | "selfhosted";
  signedPlayback(videoRef: string, ctx: { userId: string; ttlSeconds: number }): Promise<{ url: string; type: "hls" | "embed" | "mp4"; expiresAt: Date }>;
  describe(videoRef: string): Promise<{ durationSeconds?: number; ready: boolean }>;
}
```

Progreso: el reproductor envía la posición cada ~15 s (`PUT .../progress`), marca como completada al llegar a cerca del 90% visto; el progreso del curso se deriva. Campus: biblioteca de cursos, página del curso (módulos/lecciones, reanudar), reproductor (HLS mediante hls.js o embed), barra de progreso. Certificados y quizzes aplazados.

Compromisos del alojamiento de video (los modelos de precio varían y cambian; verificar los precios vigentes antes de decidir, no los revisé):

| Opción | Fortalezas | Debilidades | Encaje |
|---|---|---|---|
| Self-hosted (almacenamiento de objetos + ffmpeg HLS + nginx/CDN) | sin tarifas por minuto, propiedad total de los datos, sin dependencia de proveedor | hay que encargarse del transcoding, el ancho de banda, la lógica de URLs firmadas y el escalado; pesado de exigir a cada comprador | bueno como adaptador tardío de "trae tu propia infraestructura" |
| Bunny Stream | API simple, HLS, autenticación por token, modelo de precios por almacenamiento+ancho de banda típicamente económico, biblioteca por comprador | analítica más limitada, dependencia del proveedor | mejor opción por defecto para reventa: cada comprador trae su propia cuenta |
| Mux | mejor experiencia de desarrollo, reproducción firmada, analítica sólida, calidad adaptativa | precio por minuto almacenado y entregado, normalmente el más caro a pequeña escala | opción premium |
| Vimeo | embeds sencillos, privacidad a nivel de dominio, familiar para los compradores | límites de plan, restricciones de marca/embed, API menos adecuada para firma por espectador | ruta aceptable de "embed externo" |
| Cloudflare Stream | simple, URLs firmadas, modelo de precios por minuto de almacenamiento + entrega | compromiso similar al de Mux por el precio por minuto, menos funciones de reproductor | alternativa sólida |
| Embed externo (URL no listada de YouTube/Vimeo) | costo/esfuerzo cero | sin control de acceso real, la URL puede filtrarse | solo como solución provisional |

Recomendación: publicar primero el puerto `VideoProvider` con los adaptadores `external` y Bunny; los compradores configuran su propia cuenta en la configuración de la instancia.

### 6.6 Fase 6: distribución y puntos de extensión

Todo lo siguiente debe poder diseñarse ahora y construirse más tarde. Implicaciones arquitectónicas a respetar desde P3:

| Aspecto | Decisión para mantener la puerta abierta |
|---|---|
| Contrato de la API pública | prefijo `/v1` para los endpoints nuevos, un único envelope de error, schemas zod -> OpenAPI generado (hoy no está en las dependencias), cambios solo aditivos dentro de v1, headers de deprecación |
| Autenticación para máquinas | API keys: `platform.api_keys (id, name, prefix, key_hash, scopes[], created_by, last_used_at, revoked_at)`, con hash en reposo, mostradas una sola vez; scopes como `catalog:read`, `bookings:create`, `orders:ingest`; rate limits por clave (`@fastify/rate-limit` ya se usa en las rutas de auth/portfolio/contact) |
| Autenticación de usuarios finales en un sitio anfitrión | intercambio de token (SSO): el servidor del plugin anfitrión firma una aserción de corta duración con el secreto de la instancia; `POST /v1/sso/exchange` asocia el usuario anfitrión con una cuenta por email verificado y devuelve una sesión del campus. Evita pedir a los clientes de WP/Shopify que inicien sesión dos veces |
| CORS y embedding | los orígenes permitidos pasan del array en código (`app.ts`) a la configuración de la instancia (lista administrada por el admin); los embeds usan claves con scope, nunca JWT de admin |
| Webhooks salientes | eventos `booking.created|cancelled|rescheduled`, `order.paid|refunded`, `enrollment.created|revoked`, `credit.granted`; `platform.webhook_endpoints (url, secret, events[])`; la entrega = tipo de job `webhook.deliver` de P1 con header de firma HMAC-SHA256, timestamp, reintento/backoff y visibilidad de dead-letter sin costo adicional |
| Webhooks entrantes / pedidos externos | `POST /v1/orders/external` con una clave de idempotencia, para Shopify/otros checkouts que cobran en otro lugar, con fulfillment mediante el registro de fulfillers por tipo de P5 |
| Fuentes de catálogo | puerto `CatalogSource` (`lib/wp.ts` pasa a ser el adaptador de WP); `products` recibe una columna `source`; siguen los productos de Shopify y el catálogo manual |
| Widgets embebibles | web components con shadow DOM y CSS custom properties para el tema (`<platform-booking>`, `<platform-teachers>`, `<platform-courses>`), servidos desde el hub con bundles versionados, hablan con `/v1` usando una clave de scope público |
| White-label | tokens de tema + nombre de marca + logo + remitente de correo en la configuración de la instancia; el campus lee un documento `/v1/branding` al arrancar; sin strings de marca en el código |
| i18n | locale en cada recurso visible para el usuario; la API devuelve campos traducidos con clave por locale; el lado de WP usa su propio plugin multilingüe; el campus tiene `es`/`en` hoy (`i18n/locales`) |
| Licenciamiento/activación | ver 7.2; el lado del conector solo necesita un endpoint `/v1/instance` consciente de la licencia |

Subfases:
- 6a: endurecimiento de la API `/v1`, OpenAPI, API keys, webhooks salientes, CORS en la configuración, `GET /v1/instance`. Salida: un script externo con una API key lista catálogo/profesores/slots y recibe un webhook `booking.created` firmado; documentación publicada.
- 6b: plugin de WordPress (servidor a servidor con una API key: shortcodes/bloques para reserva, catálogo y directorio de profesores, intercambio SSO, receptor de webhooks). Delgado: sin lógica de negocio. Salida: instalar en un WP limpio, conectar con una URL de instancia + clave, embeber el widget de reserva, una compra aparece en el campus.
- 6c: Shopify (bloque de app embed + app proxy para widgets, webhook `orders/paid` -> `POST /v1/orders/external`, vinculación de cuenta de cliente). Necesita la ruta de pedidos externos y los fulfillers por tipo. Salida: un pedido de Shopify otorga créditos/acceso a cursos de forma idempotente.
- 6d: módulos de Drupal y Joomla: solo widgets embebidos + intercambio SSO. Salida: el widget se renderiza, SSO funciona. Deberían ser casi copias de la lógica de cliente de 6b.

---

## 7. Aspectos transversales

### 7.1 Un solo tenant por despliegue: qué pasa de env a la DB

Regla: los secretos y direcciones de INFRAESTRUCTURA permanecen en env (URL de la DB, URL de Redis, secretos JWT, credenciales SMTP, `APP_ENCRYPTION_KEY`, secretos de los proveedores de pago). La configuración de NEGOCIO que un admin debería poder cambiar sin redesplegar va a la DB (`platform.settings`, con los secretos cifrados con `APP_ENCRYPTION_KEY`).

| Configuración | Hoy | Objetivo |
|---|---|---|
| Conexión(es) de calendario | `CALDAV_URL/USERNAME/PASSWORD` | `calendar_connections` por profesor (P3) |
| Identidad del profesor | `MENTORING_TEACHER_ID` | `teacher_profiles` (P3) |
| Buzón de notificaciones del admin | env `ADMIN_NOTIFICATION_EMAIL` + `hola@jesusuzcategui.com` fijo en código (contact, portfolio) | configuración |
| Marca: nombre, from-name, colores, logo, pie de correo | `SMTP_FROM_NAME`, `BRAND_COLOR`, strings | configuración |
| Zona horaria, corte de cancelación, duración del slot, validez por defecto de créditos | literales `America/Bogota`, 24 h, 1 h, 60 d | configuración (zona horaria por instancia, sobrescritura por profesor más adelante) |
| Proveedor/URL base del enlace de reunión | `JITSI_BASE_URL` + host fijo en portfolio | configuración de `MeetingLinkProvider` |
| Orígenes de CORS, URLs públicas/del campus | array en código + `CAMPUS_ORIGIN`/`PORTFOLIO_ORIGIN`/`APP_PUBLIC_URL` | configuración |
| Interruptores de métodos de pago | ya en la DB (`ecommerce.payment_method_settings`) | sin cambios |
| Credenciales del proveedor de video | n/a | configuración (P5) |
| Locale por defecto | `accounts.locale` por defecto `es` | configuración |

Arranque inicial (bootstrapping): los valores de env siguen funcionando como valores por defecto durante un release después de que exista la tabla de configuración; el flujo de setup los importa.

### 7.2 Licenciamiento y activación (solo diseño)

- Modelo: documento de licencia firmado (firma Ed25519, clave pública incluida en la imagen) que contiene id de instancia, licenciatario, funcionalidades, límites (máximo de profesores, cursos habilitados, conectores habilitados), emisión/vencimiento y una ventana de gracia. Se verifica sin conexión al arrancar y a diario. Activación en línea opcional contra el servicio de licencias del propietario para revocación/renovación (el proyecto existente "Hub Vanjex" del propietario es un candidato para alojarlo, según las notas del propietario; no verificado desde este repositorio).
- Política ante fallos: nunca interrumpir clases en curso porque un servidor de licencias sea inalcanzable. Una licencia vencida/inválida se degrada con elegancia: los datos existentes y las clases programadas siguen funcionando, se bloquea agregar nuevos profesores/cursos o habilitar nuevos conectores, con un banner visible. Esto protege a los clientes del comprador.
- Los puntos de aplicación son pocos: creación de profesores, publicación de cursos, creación de API keys, habilitación de conectores. Mantenerlos detrás de una única llamada `license.can("feature")` para que la política comercial pueda cambiar sin tocar el código de negocio.
- Límite honesto: cualquier verificación de licencia autoalojada puede ser eludida por quien tenga el código fuente. Tratarla como contractual y de comodidad, no como DRM. El plan de distribución de imagen/código fuente (decisión abierta 9) importa más que la verificación.

### 7.3 Historia de distribución y actualización para compradores

Brechas encontradas en el repositorio que impiden entregarlo a otra persona:
- `hexagonal-payments-core` es una dependencia git privada de GitHub; el `Dockerfile` necesita `GH_TOKEN` en tiempo de build (`Dockerfile`, `package.json`). Los compradores no pueden compilarlo. Publicarlo en un registry o incorporarlo al repositorio (vendor) antes de P6.
- Las migraciones se ejecutan en cada arranque (`server.ts`), lo cual es cómodo para un solo nodo pero necesita: una nota de respaldo previo a la migración, política de solo avance (forward-only) y un `schema_version` visible en `/v1/instance`. `db/migrate.ts repairSchema` reaplica DDL idempotente de las migraciones 0005/0006 en cada arranque, lo que indica una deriva histórica en la base de datos del propietario; una base de datos nueva de un comprador no debería necesitarlo (no verificado que 0005/0006 por sí solas reproduzcan el mismo schema; probar una migración desde cero antes de entregar).
- `seedMentoring` en cada arranque con datos y email del propietario (2.3) debe convertirse en un asistente de configuración de primer arranque (`/setup`: crear el primer admin, nombre de la instancia, zona horaria, slots de demo opcionales), deshabilitado una vez que existe un admin. `scripts/grant-admin-and-reset-password.mjs` se mantiene como herramienta de recuperación.
- Proveer un bundle de compose (app, Postgres, Redis si se conserva, Caddy opcional como ya sugiere `Caddyfile.example`) y un comando de actualización documentado. Respaldos: guía de `pg_dump` y un simulacro de restauración, además de señalar la ubicación de los datos del proveedor de video y de WebDAV (almacenamiento de comprobantes/notas, `plugins/webdav.ts`) porque están fuera de Postgres.
- Redis hoy no se usa (2.1). Decidir si se conserva como dependencia para los compradores (la decisión abierta 1 toca esto). Eliminar un servicio innecesario reduce la fricción de instalación.

### 7.4 Seguridad y aislamiento

- Secretos en reposo: las credenciales de la conexión de calendario se cifran con AES-256-GCM con una clave maestra de env, nunca se devuelven por ninguna API, nunca se registran en logs; procedimiento de rotación de claves documentado.
- Las URLs suministradas por profesores (dirección del servidor CalDAV) son un vector de SSRF una vez que los profesores puedan configurar conexiones: validar el esquema, resolver y rechazar rangos privados/link-local salvo que un flag de la instancia permita redes privadas autoalojadas, imponer timeouts y límites de tamaño de respuesta.
- La impersonación debe registrar al actor (claim `act`, fila en `audit_logs`). Hoy no existe ninguno de los dos (2.2).
- Login/sesión: el JWT de acceso es HS256 con un único secreto compartido. Si algún día conectores de terceros verifican tokens, pasar a asimétrico (EdDSA/RS256) o mantener la verificación solo del lado del servidor. No es necesario antes de P6.
- Aislamiento por profesor: 6.2 (helper de alcance, matriz de tests entre profesores, RLS como endurecimiento posterior).
- Minimización de PII en jobs y logs (5.14, 5.17).
- Ya existe rate limiting en las rutas de auth, portfolio y contact mediante `@fastify/rate-limit`; extenderlo a las API keys en P6a.
- La verificación de firma de webhooks ya existe para ePayco/PayPal y WP (`X-Webhook-Secret` con `timingSafeEqual`, `products.routes.ts`); los webhooks salientes reutilizan la misma disciplina de HMAC.

### 7.5 i18n

- Las cuentas llevan `locale` (`es|en`, restricción CHECK en la migración 0016); los correos a estudiantes se localizan mediante los constructores en `schedule/student-emails.ts`. Varios mensajes están solo en español sin importar el locale (aviso de reserva al admin, alerta de revisión, restablecimiento de contraseña, enlace de carrito en una variante de idioma). Consolidar en un catálogo de plantillas con clave por locale (`email.<template>.<locale>`) con fallback al valor por defecto de la instancia; los handlers de P1 conservan los strings actuales (sin cambio de comportamiento), la consolidación del catálogo es P3.
- El i18n de contenido vive en WP (plugin multilingüe); el hub almacena campos `jsonb` por locale donde es dueño del contenido (skills, bios) y los devuelve según `?locale=`/`Accept-Language`.
- Fechas: dejar de fijar en código `America/Bogota` y los literales `-05:00`; almacenar en UTC, renderizar según la configuración de zona horaria del profesor/estudiante/instancia. El generador de slots (`upcomingOccurrences`, `series.ts`) es el lugar principal que necesita una reescritura consciente de zonas horarias.

### 7.6 Observabilidad

- Hoy: logs de pino de Fastify (`logger: true`), una fila de `request_logs` por petición mediante un hook `onResponse` (cada petición escribe en Postgres; el volumen crece sin límite, no se encontró retención), `/health` devuelve `{ status: "ok" }` sin comprobar la DB ni Redis.
- Agregar en P1: logs/stats de jobs (5.17). Agregar para P3: `/health/ready` (DB alcanzable, migraciones al día, lag de jobs bajo el umbral), retención de request-log, propagación del id de correlación (`request_id`), `/metrics` de Prometheus opcional y un hook de seguimiento de errores (adaptador de Sentry) detrás de flags de env. Cada uno es opcional por comprador.
- Mínimo de alertas: cantidad de jobs dead y antigüedad del pending más viejo en el dashboard del admin; correo opcional al admin con throttling ante el primer job dead en una hora.

---

## 8. Decisiones abiertas para el propietario

Numeradas, cada una con opciones, mi recomendación y el costo de equivocarse.

1. **Sustrato de la cola para P1.** (a) outbox en Postgres + worker en proceso solamente; (b) outbox + relay a BullMQ desde ahora. Se recomienda (a). Costo de equivocarse: si más adelante se necesita un throughput de nivel Redis, se agrega un relay y un nuevo consumidor (aproximadamente S) mientras la ruta de escritura y los tests permanecen; elegir (b) ahora agrega una dependencia de Redis para cada comprador y dos modos de fallo antes de tener el volumen. Relacionado: Redis hoy no se usa; decidir si permanece en el bundle de instalación.
2. **Ubicación del worker.** (a) embebido en el proceso de la API detrás de `JOBS_ENABLED`; (b) proceso de worker separado desde el primer día. Se recomienda (a) porque coincide con reminders/calendar-sync/payment-verification y mantiene un contenedor por comprador; la lógica de claim es independiente del proceso, por lo que sacarlo después es barato. Costo de equivocarse: un handler lento puede quitarle CPU a HTTP; mitigado por la concurrencia de 4 y los timeouts. Revisar cuando un comprador tenga un volumen alto.
3. **Cómo se modela a un admin que también enseña.** (a) capacidad de profesor = existencia de una fila activa en `teacher_profiles`, independiente de `role` (el propietario es admin Y profesor); (b) una sola columna `role` y una segunda cuenta para enseñar; (c) cambiar `role` a un array. Se recomienda (a). Costo de equivocarse: (b) obliga al propietario a manejar dos logins y divide sus datos; (c) es un refactor grande de auth con poca ganancia.
4. **Dónde viven las credenciales del calendario.** (a) DB, AES-256-GCM con una clave maestra en env; (b) KMS/Vault; (c) mantener solo env (una única conexión). Se recomienda (a) para P3. Costo de equivocarse: (c) no puede soportar un segundo profesor; (b) agrega infraestructura que ningún comprador va a ejecutar; perder la clave maestra vuelve irrecuperables las conexiones (documentar el respaldo de la clave).
5. **Desnormalizar `bookings.teacher_id` en P3.** Se recomienda que sí (con backfill, luego NOT NULL). Costo de equivocarse: derivar al profesor siempre mediante joins con `weekly_slots`/`availabilities`, lo que falla con slots reasignados, slots eliminados (`ON DELETE restrict` hoy) y con cada consulta/índice por profesor.
6. **Nomenclatura de roles.** Mantener el enum almacenado `user|admin|teacher`, introducir `student` solo a nivel de API/UI. Se recomienda eso. Costo de equivocarse: renombrar el valor del enum requiere una migración que toca todas las cuentas y un release coordinado del campus por poco valor de producto.
7. **P4 antes o después de P5.** (a) mantener el orden (perfiles y luego cursos); (b) cursos primero si se planea un curso de pago dentro de unos 3 meses, con solo un perfil mínimo de profesor en P3. Se recomienda (b) si el ingreso por cursos es de corto plazo, de lo contrario (a). Costo de equivocarse: retrasar los ingresos (si se elige a) o publicar cursos sin matching de profesores (aceptable; son independientes).
8. **Adaptador de proveedor de video por defecto.** Se recomienda el puerto `VideoProvider` con `external` + Bunny primero, y que los compradores traigan su propia cuenta. Alternativas: Mux (mejor DX, más caro), self-host (más trabajo). Costo de equivocarse: re-codificar/migrar videos entre proveedores es un problema de operación de contenido, no de código, por lo que conviene mantener `video_ref` con alcance por proveedor y nunca exponer públicamente las URLs del proveedor.
9. **Modelo de licenciamiento y cómo se distribuye el producto** (acceso al código fuente vs imágenes construidas). Se recomienda una licencia firmada verificable sin conexión + activación en línea opcional, degradación elegante, entregar imágenes construidas (no código fuente) y publicar primero `hexagonal-payments-core` en un registry. Costo de equivocarse: un phone-home obligatorio rompe las clases de los compradores durante una caída propia; el sistema solo basado en confianza no da ninguna palanca; entregar el código fuente vuelve cosmética cualquier verificación. **Requisitos del propietario agregados el 2026-10-07 (vinculantes para el diseño del licenciamiento):** la versión comercial necesita un apartado de licenciamiento; el comprador activa la instalación con una clave de licencia definida en el entorno de la instancia (se valida al instalar o al arrancar, no es una pantalla que vea el usuario final); el licenciamiento debe permitir al propietario saber cuántas copias se han vendido y hasta cuándo se brinda soporte a cada cliente (derecho de soporte o vencimiento asociado a la licencia). Es el mismo sistema que el proyecto planificado de consola del propietario y licenciamiento de software (véanse la memoria y las notas sobre la consola Nodus, el portal y el licenciamiento de Hub Vanjex); deben diseñarse juntos: el hub solo verifica y reporta, y la consola emite, revoca y cuenta.
10. **Estrategia de contrato.** (a) `/v1` + envelope normalizado para los endpoints NUEVOS desde P3, heredados congelados; (b) reescribir la API antes de P6. Se recomienda (a). Costo de equivocarse: (b) detiene el trabajo de producto y pone en riesgo la integración con el campus/Astro; ignorarlo convierte P6 en una reescritura de todos modos.
11. **Comportamiento del worker bajo `pnpm dev`.** (a) apagado por defecto con `POST /admin/jobs/run` y un flag explícito, igual que los otros tres flags; (b) encendido, con un transporte de correo que solo registra en logs y un proveedor de calendario no-op. Se recomienda (a) por consistencia ahora; (b) es una mejor experiencia de desarrollo una vez que exista P2. Costo de equivocarse: las reservas locales no hacen nada en silencio (a) o un envío real inadvertido (si (b) está mal configurado). Nótese que esto es un cambio de comportamiento respecto de hoy, donde los correos de reserva inline y los PUT de CalDAV sí se disparan en dev.
12. **Restricción de Google Calendar.** El brief indica que Google necesita una cuenta de Workspace que el propietario no tiene, por lo que P7 se aplaza. Salvedad a verificar antes de tratar esto como permanente: el flujo de consentimiento OAuth de usuario de Google está generalmente disponible también para cuentas de Google de consumo; Workspace normalmente se necesita para la delegación a nivel de dominio con cuentas de servicio, no para OAuth por usuario. No verifiqué la política vigente de Google (incluidos los requisitos de verificación de la app para scopes sensibles). Se recomienda: mantener P7 aplazado como se acordó, pero no describirlo ante los compradores como imposible sin comprobarlo. Costo de equivocarse: prometer de más un conector o dejar sobre la mesa una funcionalidad diferenciadora.
13. **Redis: opcional en el producto, activado en la instancia del propietario (DECIDIDO 2026-10-07).** Hallazgo: `REDIS_URL` es obligatoria al arrancar (`src/config/env.ts`) y `src/plugins/redis.ts` se conecta, pero ningún módulo usa Redis; el carrito vive en Postgres (`ecommerce.carts`), lo que contradice `hub-backend-plan.md` ("Carrito: Redis"), y `@fastify/rate-limit` (rutas de carrito y contacto) no está configurado con un store de Redis, por lo que los límites son por proceso. Decisión: hacer Redis opcional, con un pequeño puerto de caché y limitador que tenga dos adaptadores: en memoria (por defecto, un solo nodo, sin servicios adicionales) y Redis (se activa cuando `REDIS_URL` está definida). El despliegue del propietario corre con Redis para cachear todo lo que resulte útil (respuestas del catálogo de WordPress y de las páginas legales, contadores de rate limit compartidos entre instancias y, más adelante, BullMQ si la cola en Postgres se queda corta). Requisitos: el hub debe arrancar y comportarse correctamente sin Redis; una caída de Redis debe degradar al adaptador en memoria (registrar en el log y continuar), nunca tumbar la API; el carrito se queda en Postgres (transaccional con el checkout, con llave foránea desde las órdenes); las entradas de caché se identifican por despliegue y se invalidan con el webhook de productos de WordPress. Costo de equivocarse: mantener Redis obligatorio agrega un servicio que cada comprador debe operar y convierte una falla de Redis en una caída total; eliminarlo por completo pierde los límites compartidos al escalar a dos instancias. Calendario: una porción pequeña justo después de P1 (tamaño S), independiente de las demás fases; actualizar `hub-backend-plan.md` para que refleje la realidad.

---

## 9. Riesgos y aplazamientos deliberados

### 9.1 Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| P1 toca 12 puntos de llamada en dos archivos de 800-1100 líneas | regresión en reservas/pagos | un PR por paso de despliegue (5.15), el código de los handlers se mueve, no se reescribe, las suites existentes deben pasar, liquidación al final |
| Consistencia eventual de calendario/correo | la UI espera efectos secundarios instantáneos | documentado, cuerpo del 201 sin cambios, `expires_at` y stats |
| Migración de los datos del propietario en P3 (`bookings.teacher_id`, conexiones) | backfill incorrecto, eventos huérfanos | primero un reporte de dry-run, backfill en una migración con una consulta de verificación, mantener el fallback de env durante un release |
| Refactor de authz en P3 | fuga de privilegios entre profesores | un único helper de alcance + matriz de tests entre profesores como requisito para el merge |
| Refactor del fulfillment de pagos en P5 | otorgamientos duplicados/fallidos | mantener el fulfiller de créditos byte a byte, agregar el fulfiller de cursos a su lado, reutilizar la maquinaria existente de `needs_review` |
| `hexagonal-payments-core` es un paquete privado congelado y fijado | bloquea a los compradores, limita los cambios | publicarlo/incorporarlo antes de P6; tratar la extensión del registro de tipos como el único cambio necesario |
| La liquidación no es transaccional (2.4 #9) | otorgamientos parciales ante una caída | registrado como seguimiento; la maquinaria de `needs_review` ya detecta otorgamientos fallidos |
| El código de timezone/slots tiene Bogotá fijada en código | slots incorrectos para otras regiones | ítem explícito de limpieza de P3 (7.5) |
| Verificación de apps de terceros (Google/Microsoft) | plazo largo para P7 | comenzar solo cuando un comprador lo necesite |
| Capacidad de un único mantenedor | el roadmap se retrasa | las fases son entregables de forma independiente; P1+P2 ya entregan la mejora de confiabilidad |

### 9.2 Aplazado deliberadamente

- Mover los recordatorios y la reverificación de pagos a la cola de jobs (funcionan; convertir de forma oportunista).
- Hacer que la liquidación sea una sola transacción y que el reschedule sea atómico (preexistente; corrección separada, de bajo riesgo una vez que P1 esté integrada).
- Despertares por LISTEN/NOTIFY para el worker, limitación de tasa por proveedor, heartbeats de jobs, prioridades/colas, jobs programados/recurrentes en la tabla.
- Endpoint de Prometheus, tracing, integración con Sentry (adaptadores opcionales más adelante).
- Row-level security de Postgres (defensa en profundidad una vez que exista un segundo profesor real).
- Certificados, quizzes, DRM, clases en vivo, pagos/comisiones a profesores, hosting multi-tenant, apps nativas, PWA.
- Adaptadores de Google y Outlook (P7).
- UI del campus para la cola de jobs (los endpoints se publican en P1; la pantalla es un seguimiento pequeño).
- Notificar a los admins la creación de una serie (hoy solo las reservas individuales notifican a los admins, 2.4 #4 vs #1): se preserva tal cual en P1; confirmar si esa brecha es intencional.
