FROM node:22-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN apk add --no-cache git

WORKDIR /app

# hexagonal-payments-core is a private git dependency — same token-based
# auth as jesusuzcategui-campus's Dockerfile, for the same reason (Coolify
# has no --secret mount support). Set and unset within this single RUN so
# the net filesystem diff for this layer never includes the token, in this
# stage and in the production stage below (which does its own install and
# isn't discarded, so the same care applies there too).
ARG GH_TOKEN
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/" \
  && pnpm install --frozen-lockfile \
  && git config --global --unset url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY mentoring-availability.json ./

RUN pnpm run build

FROM node:22-alpine AS production

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN apk add --no-cache git

WORKDIR /app

ARG GH_TOKEN
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/" \
  && pnpm install --frozen-lockfile --prod \
  && git config --global --unset url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY mentoring-availability.json ./
COPY scripts ./scripts

EXPOSE 3000

CMD ["node", "dist/server.js"]
