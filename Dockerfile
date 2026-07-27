# KUKAN — Multi-target Dockerfile
# Build:
#   docker build --target web -t kukan-web .
#   docker build --target worker -t kukan-worker .

# ---- Base (shared by all targets: upgraded OS + pnpm) ----
# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The digest below is node 24.18.0 on alpine 3.24.1;
# Dependabot (docker ecosystem) bumps it as the node:24-alpine tag moves.
FROM public.ecr.aws/docker/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
RUN apk upgrade --no-cache && corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/lake/package.json packages/lake/
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
# DuckDB downloads extensions from the internet on first use (ADR-043 layer 2).
# Fetch them at build time: a closed-network deployment (LGWAN and similar) has
# no egress, and even with egress the first query would stall on ~99 MB.
ENV DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-extensions
# Next.js standalone hoists packages under .pnpm, so resolve from there.
WORKDIR /app/node_modules/.pnpm/node_modules
RUN node --input-type=module -e "const {DuckDBInstance} = await import('@duckdb/node-api'); const i = await DuckDBInstance.create(':memory:', {extension_directory: process.env.DUCKDB_EXTENSION_DIRECTORY}); const c = await i.connect(); for (const e of ['httpfs','aws','postgres','ducklake']) { await c.run('INSTALL ' + e); await c.run('LOAD ' + e) }"
WORKDIR /app
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
#
# --no-optional also drops DuckDB's platform binding, which is an optional
# dependency of @duckdb/node-bindings — without it DuckLake (ADR-043 layer 2)
# throws on the first ingest. The deps stage installed it for this image's own
# platform, so copy that one back in rather than widening the flag.
FROM build AS worker-deps
# The glob copies whichever binding the deps stage resolved for this image's
# platform, so an arm64 build needs no change here.
RUN pnpm --filter @kukan/worker deploy --prod --no-optional --legacy /app/worker-deploy \
  && mkdir -p /app/worker-deploy/node_modules/.pnpm/node_modules/@duckdb \
  && cp -RL /app/node_modules/.pnpm/node_modules/@duckdb/node-bindings-* \
    /app/worker-deploy/node_modules/.pnpm/node_modules/@duckdb/

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
# DuckDB downloads extensions from the internet on first use (ADR-043 layer 2).
# Fetch them at build time: a closed-network deployment (LGWAN and similar) has
# no egress, and even with egress the first ingest would stall on ~99 MB.
ENV DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-extensions
RUN node --input-type=module -e "const {DuckDBInstance} = await import('@duckdb/node-api'); const i = await DuckDBInstance.create(':memory:', {extension_directory: process.env.DUCKDB_EXTENSION_DIRECTORY}); const c = await i.connect(); for (const e of ['httpfs','aws','postgres','ducklake']) { await c.run('INSTALL ' + e); await c.run('LOAD ' + e) }"
ENV NODE_ENV=production HEALTH_PORT=8080
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
