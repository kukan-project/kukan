# KUKAN — Multi-target Dockerfile
# Build:
#   docker build --target web -t kukan-web .
#   docker build --target worker -t kukan-worker .

# ---- Base (shared by all targets: upgraded OS + pnpm) ----
FROM public.ecr.aws/docker/library/node:24-alpine AS base
RUN apk upgrade --no-cache && corepack enable && corepack prepare pnpm@10 --activate
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
# Web image brand (ADR-042): --build-arg KUKAN_BRAND=<name> selects
# apps/web/brands/<name>; unset → the default brand. Ignored by the worker.
ARG KUKAN_BRAND
ENV KUKAN_BRAND=${KUKAN_BRAND}
COPY . .
RUN pnpm build --filter='!@kukan/site'

# ---- Web (Next.js standalone) ----
FROM base AS web
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# DuckDB native bindings for server-side resource queries (ADR-032 Part B).
# Next.js standalone traces the .node addon but not libduckdb.so (a dynamic dependency).
# Copy it to a dedicated directory and point LD_LIBRARY_PATH there.
COPY --from=deps /app/node_modules/.pnpm/@duckdb+node-bindings-linux-x64-musl@*/node_modules/@duckdb/node-bindings-linux-x64-musl/libduckdb.so /app/duckdb-lib/
# Remove the bundled npm CLI: runtime uses pnpm via corepack, never npm, and npm's
# bundled undici carries CVE-2026-12151. Dropping it clears the finding and trims surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser
ENV NODE_ENV=production PORT=3000 LD_LIBRARY_PATH=/app/duckdb-lib
EXPOSE 3000
# Override HOSTNAME so Next.js standalone server binds to 0.0.0.0 (not the container IP).
# The container runtime sets HOSTNAME to the container's IP, causing Next.js to bind only
# to that IP. The App Runner health check uses localhost, so it would fail without this.
CMD ["/bin/sh", "-c", "HOSTNAME=0.0.0.0 node apps/web/server.js"]

# ---- Worker production dependencies (prod-only, isolated node_modules) ----
# `pnpm deploy --prod` resolves just the worker's production dependencies into a
# self-contained node_modules, excluding devDependencies. --no-optional drops
# better-auth's optional `vitest` peer, which otherwise drags vite/esbuild/jsdom
# (and dozens of CVEs) into the runtime image even in prod mode. --legacy is
# required for deploy with inject-workspace-packages disabled.
FROM build AS worker-deps
RUN pnpm --filter @kukan/worker deploy --prod --no-optional --legacy /app/worker-deploy

# ---- Worker (tsup bundle — workspace packages are bundled, npm deps are external) ----
FROM base AS worker
WORKDIR /app
COPY --from=worker-deps /app/worker-deploy/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/packages/db/drizzle ./apps/worker/drizzle
# Remove the bundled npm CLI: runtime uses pnpm via corepack, never npm, and npm's
# bundled undici carries CVE-2026-12151. Dropping it clears the finding and trims surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser
ENV NODE_ENV=production HEALTH_PORT=8080
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
