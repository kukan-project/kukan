# KUKAN — Multi-target Dockerfile
# Build:
#   docker build --target web -t kukan-web .
#   docker build --target worker -t kukan-worker .

# ---- Base (what the images run on: upgraded OS) ----
# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The digest below is node 24.22.1 on alpine 3.24.
# Dependabot (docker ecosystem) is configured to bump it as the node:24-alpine
# tag moves, but has not once for this registry: compare `node -v` here with
# the tag's by hand until it does. `apk upgrade` covers the OS packages
# meanwhile; nothing covers node itself, which a scan of the image does not see.
# The other places that name the Node version are listed in docs/node-version.md.
FROM public.ecr.aws/docker/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
RUN apk upgrade --no-cache
# CA bundle the AWS deployment verifies RDS and Aurora against (CDK points
# POSTGRES_SSLROOTCERT here). The checksum fails the build when AWS changes the
# bundle, rather than letting it change unseen: fetch the new one, check what
# it adds, and bump the digest. A remote ADD lands as 600, which the images'
# non-root user could not read, and --chmod would give a directory it creates
# the file's mode too, so the bundle goes into one that exists. Not *.pem:
# Lambda Web Functions' deploy drops those from its zip (ADR-068). ADD
# --checksum needs the Dockerfile frontend 1.6 or later.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-ca.crt
WORKDIR /app

# ---- Build base (the machine's own platform) ----
# Install and build produce JavaScript, the same on every platform, so they run
# natively: an arm64 image built on x86_64 would otherwise do them under QEMU.
# Only the stages the image is made of run on the target platform. The same
# image as `base`: bump the two digests together.
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build-base
WORKDIR /app

# ---- Dependencies ----
# pnpm is installed here rather than in `base`, which the images derive from.
# It unpacks ~21 MB that only the build stages use, and a runtime stage built
# on `base` carried it to production — with the node_modules pnpm brings (tar,
# brace-expansion, ip-address), which scanners then report against an image
# that never runs pnpm. A later `rm` would not have helped: the bytes stay in
# the layer that wrote them. The script installs the version and hash that
# `packageManager` names, without corepack (gone from Node 25 on).
FROM build-base AS deps
COPY package.json ./
COPY scripts/install-pnpm.sh scripts/
RUN sh scripts/install-pnpm.sh
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/lake/package.json packages/lake/
COPY packages/ui/package.json packages/ui/
COPY packages/queue/package.json packages/queue/
COPY packages/adapters/search/package.json packages/adapters/search/
COPY packages/adapters/storage/package.json packages/adapters/storage/
COPY packages/adapters/ai/package.json packages/adapters/ai/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
# Native packages for both architectures: the build tools need this machine's
# and the image the target's (pnpm otherwise installs only this machine's).
# Installing both whichever they are keeps this stage and `build` the same for
# every target, so building the other architecture reuses them.
RUN printf '\nsupportedArchitectures:\n  os: [linux]\n  libc: [musl]\n  cpu: [x64, arm64]\n' >> pnpm-workspace.yaml \
  && pnpm install --frozen-lockfile

# ---- Build ----
FROM deps AS build
# Web image brand (ADR-042): --build-arg KUKAN_BRAND=<name> selects
# apps/web/brands/<name>; unset → the default brand. Ignored by the worker.
ARG KUKAN_BRAND
ENV KUKAN_BRAND=${KUKAN_BRAND}
COPY . .
RUN pnpm build --filter='!@kukan/site'

# ---- Web files (the target's native binaries only) ----
# The standalone output traces both architectures' bindings the deps stage
# installed; keep the target's. Next.js traces the DuckDB .node addon but not
# libduckdb.so (a dynamic dependency), so that is picked out here as well.
FROM build AS web-files
ARG TARGETARCH
RUN target=$(echo "$TARGETARCH" | sed 's/^amd64$/x64/') \
  && cd apps/web/.next/standalone/node_modules/.pnpm \
  && for d in @duckdb+node-bindings-linux-*-musl@* @img+sharp-linuxmusl-*@* @img+sharp-libvips-linuxmusl-*@* \
      node_modules/@duckdb/node-bindings-linux-*-musl node_modules/@img/sharp-linuxmusl-* node_modules/@img/sharp-libvips-linuxmusl-*; do \
      case "$d" in *-"$target"-musl*|*linuxmusl-"$target"*) ;; *) rm -rf "$d" ;; esac; \
    done \
  && mkdir /app/duckdb-lib \
  && cp /app/node_modules/.pnpm/@duckdb+node-bindings-linux-"$target"-musl@*/node_modules/@duckdb/node-bindings-linux-"$target"-musl/libduckdb.so /app/duckdb-lib/

# ---- Web (Next.js standalone) ----
FROM base AS web
WORKDIR /app
# The user comes before the copies so their contents land owned. `chown -R`
# after them rewrites every file it touches into a layer of its own, which had
# this image carrying 235 MB that duplicated what the copies had just written,
# and the worker 369 MB.
#
# The runtime starts `node` and nothing else — the entrypoints below, the ECS
# health checks (wget), and the documented in-container tools all do — so what
# the node image ships for installing things goes. npm's bundled undici carried
# CVE-2026-12151; corepack and the yarn shims are commands that fetch an
# unpinned package manager over the network before they run anything, which is
# a gift to whoever gets a shell here. pnpm is not on this list because it is
# not here: `deps` prepares it, and this stage comes from `base`.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup -S appgroup && adduser -S appuser -G appgroup && chown appuser:appgroup /app
COPY --chown=appuser:appgroup --from=web-files /app/apps/web/.next/standalone ./
COPY --chown=appuser:appgroup --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=appuser:appgroup --from=build /app/apps/web/public ./apps/web/public
# The entry, which hands Lambda Web Functions' listen address to the server
COPY --chown=appuser:appgroup --from=build /app/apps/web/start.mjs ./apps/web/start.mjs
# DuckDB native bindings for server-side resource queries (ADR-032 Part B):
# libduckdb.so sits in a dedicated directory LD_LIBRARY_PATH points at.
COPY --chown=appuser:appgroup --from=web-files /app/duckdb-lib /app/duckdb-lib/
# The process a resource query runs in (ADR-032). Next bundles @kukan/api from
# source, so the child's own file is not in the standalone output. It sits
# under .pnpm because that is where @duckdb/node-api, its one import, resolves.
COPY --chown=appuser:appgroup --from=build /app/packages/api/dist/services/query/query-child.mjs /app/node_modules/.pnpm/kukan-query-child.mjs
USER appuser
ENV NODE_ENV=production PORT=3000 LD_LIBRARY_PATH=/app/duckdb-lib \
  QUERY_CHILD_ENTRY=/app/node_modules/.pnpm/kukan-query-child.mjs
# DuckDB downloads extensions from the internet on first use (ADR-043 layer 2).
# Fetch them at build time: a closed-network deployment (LGWAN and similar) has
# no egress, and even with egress the first query would stall on the download.
ENV DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-extensions
# Next.js standalone hoists packages under .pnpm, so resolve from there.
WORKDIR /app/node_modules/.pnpm/node_modules
RUN node --input-type=module -e "const {DuckDBInstance} = await import('@duckdb/node-api'); const i = await DuckDBInstance.create(':memory:', {extension_directory: process.env.DUCKDB_EXTENSION_DIRECTORY}); const c = await i.connect(); for (const e of ['httpfs','aws','sqlite','ducklake']) { await c.run('INSTALL ' + e); await c.run('LOAD ' + e) }"
WORKDIR /app
EXPOSE 3000
# start.mjs decides where Next listens (0.0.0.0 here)
CMD ["node", "apps/web/start.mjs"]

# ---- Worker production dependencies (prod-only, isolated node_modules) ----
# `pnpm deploy --prod` resolves just the worker's production dependencies into a
# self-contained node_modules, excluding devDependencies. --no-optional drops
# better-auth's optional `vitest` peer, which otherwise drags vite/esbuild/jsdom
# (and dozens of CVEs) into the runtime image even in prod mode. --legacy is
# required for deploy with inject-workspace-packages disabled.
#
# --no-optional also drops the platform binaries that ship as optional
# dependencies: DuckDB's binding (@duckdb/node-bindings-*), without which
# DuckLake (ADR-043 layer 2) throws on the first ingest, and sharp's
# (@img/sharp-* — the module plus libvips), without which the worker throws on
# boot because summarize.ts imports sharp at the top level (ADR-053). The deps
# stage installed them for both architectures, so copy the target's back in
# rather than widening the flag.
FROM build AS worker-deps
ARG TARGETARCH
RUN target=$(echo "$TARGETARCH" | sed 's/^amd64$/x64/') \
  && pnpm --filter @kukan/worker deploy --prod --no-optional --legacy /app/worker-deploy \
  && mkdir -p /app/worker-deploy/node_modules/.pnpm/node_modules/@duckdb \
  && cp -RL /app/node_modules/.pnpm/node_modules/@duckdb/node-bindings-linux-"$target"-musl \
    /app/worker-deploy/node_modules/.pnpm/node_modules/@duckdb/ \
  && mkdir -p /app/worker-deploy/node_modules/.pnpm/node_modules/@img \
  && cp -RL /app/node_modules/.pnpm/node_modules/@img/sharp-linuxmusl-"$target" \
    /app/node_modules/.pnpm/node_modules/@img/sharp-libvips-linuxmusl-"$target" \
    /app/worker-deploy/node_modules/.pnpm/node_modules/@img/

# ---- Worker (tsup bundle — workspace packages are bundled, npm deps are external) ----
FROM base AS worker
WORKDIR /app
# See the web stage for both halves: nothing that installs stays, and the user
# is created before the copies rather than chowning them afterwards.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup -S appgroup && adduser -S appuser -G appgroup && chown appuser:appgroup /app
COPY --chown=appuser:appgroup --from=worker-deps /app/worker-deploy/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=build /app/apps/worker/dist ./apps/worker/dist
# The query process the summary's sample rows read through (ADR-053), beside
# the bundle where the query service looks; @duckdb/node-api resolves from here
COPY --chown=appuser:appgroup --from=build /app/packages/api/dist/services/query/query-child.mjs ./apps/worker/dist/query-child.mjs
COPY --chown=appuser:appgroup --from=build /app/apps/worker/package.json ./apps/worker/
# The release the worker names in its User-Agent (apps/worker/src/user-agent.ts)
COPY --chown=appuser:appgroup --from=build /app/package.json ./
COPY --chown=appuser:appgroup --from=build /app/packages/db/drizzle ./apps/worker/drizzle
USER appuser
# DuckDB downloads extensions from the internet on first use (ADR-043 layer 2).
# Fetch them at build time: a closed-network deployment (LGWAN and similar) has
# no egress, and even with egress the first ingest would stall on the download.
ENV DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-extensions
RUN node --input-type=module -e "const {DuckDBInstance} = await import('@duckdb/node-api'); const i = await DuckDBInstance.create(':memory:', {extension_directory: process.env.DUCKDB_EXTENSION_DIRECTORY}); const c = await i.connect(); for (const e of ['httpfs','aws','sqlite','ducklake']) { await c.run('INSTALL ' + e); await c.run('LOAD ' + e) }"
ENV NODE_ENV=production HEALTH_PORT=8080
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
