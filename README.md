# hub-jesusuzcategui

Backend hub personal — arquitectura hexagonal con Fastify + TypeScript.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Fastify 5
- **Language:** TypeScript 5 (strict)
- **Proxy local:** Caddy 2
- **Contenedores:** Docker / Podman

## Estructura

```
src/
├── server.ts          — Entry point
├── app.ts             — App factory (plugins + módulos)
├── config/
│   └── env.ts         — Validación y tipado de variables de entorno
└── modules/           — Módulos de negocio (arquitectura hexagonal)
    └── <modulo>/
        ├── <modulo>.module.ts   — Registro de rutas
        ├── routes/              — Endpoints + validación de esquemas
        ├── controllers/         — Lógica de request/response
        ├── services/            — Lógica de negocio (implementa interfaces)
        └── types/               — Contratos (interfaces, DTOs)
```

## Setup local

### Requisitos

- Node.js 20+
- mkcert (para certificados TLS locales)
- Docker o Podman + Caddy (opcional, para HTTPS local)

### Primeros pasos

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
cp .env.example .env
# Editar .env con los valores reales

# 3. Copiar Caddyfile
cp Caddyfile.example Caddyfile

# 4. Generar certificados TLS locales
mkdir -p certs
mkcert -cert-file certs/hubjesusuzcategui.localhost.pem \
       -key-file certs/hubjesusuzcategui.localhost-key.pem \
       hubjesusuzcategui.localhost

# 5. Agregar entrada en /etc/hosts
echo "127.0.0.1  hubjesusuzcategui.localhost" | sudo tee -a /etc/hosts
```

### Desarrollo

```bash
# Solo Node (HTTP en localhost:3000)
npm run dev

# Con Docker/Podman + Caddy (HTTPS en hubjesusuzcategui.localhost)
npm run podman:run
```

### Build

```bash
npm run build    # Compila TypeScript → dist/
npm run start    # Ejecuta dist/server.js
```

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `PORT` | Sí | Puerto del servidor (default: 3000) |
| `STATE_SECRET` | Sí | Secreto para firmar tokens JWT de estado |
| `ALLOWED_REDIRECT_HOSTS` | No | Hosts permitidos para redirección (comma separated) |

## Endpoints base

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Health check |

## URLs

| Entorno | URL |
|---|---|
| Local | https://hubjesusuzcategui.localhost |
| Producción | https://hub.jesusuzcategui.com |

## Módulos

<!-- Documentar módulos aquí conforme se implementen -->

| Módulo | Prefijo | Descripción |
|---|---|---|
| — | — | — |
