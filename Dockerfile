FROM node:22-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

RUN pnpm run build

FROM node:22-alpine AS production

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY mentoring-availability.json ./

EXPOSE 3000

CMD ["sh", "-c", "echo 'Starting migrations...' && node dist/db/migrate.js && echo 'Migrations done. Starting seed...' && node dist/db/seed-mentoring.js && echo 'Seed done. Starting server...' && node dist/server.js"]
