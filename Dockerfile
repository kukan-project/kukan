# KUKAN — Multi-target Dockerfile
# Build:
#   docker build --target web -t kukan-web .
#   docker build --target worker -t kukan-worker .

# ---- Base (shared by all targets: upgraded OS + pnpm) ----
FROM node:24-alpine AS base
RUN apk upgrade --no-cache && corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
COPY packages/adapters/search/package.json packages/adapters/search/
COPY packages/adapters/storage/package.json packages/adapters/storage/
COPY packages/adapters/queue/package.json packages/adapters/queue/
COPY packages/adapters/ai/package.json packages/adapters/ai/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# ---- Build ----
FROM deps AS build
COPY . .
RUN pnpm build --filter='!@kukan/site'

# ---- Web (Next.js standalone) ----
FROM base AS web
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Override HOSTNAME so Next.js standalone server binds to 0.0.0.0 (not the container IP).
# The container runtime sets HOSTNAME to the container's IP, causing Next.js to bind only
# to that IP. The App Runner health check uses localhost, so it would fail without this.
CMD ["/bin/sh", "-c", "HOSTNAME=0.0.0.0 node apps/web/server.js"]

# ---- Worker (tsup bundle — workspace packages are bundled, npm deps are external) ----
FROM base AS worker
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/packages/db/drizzle ./apps/worker/drizzle
ENV NODE_ENV=production HEALTH_PORT=8080
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
