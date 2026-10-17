#!/usr/bin/env bash
# Build the stage 2a package in dist/: the bundled server, KUKAN's query-child.mjs,
# and — inside an arm64 Amazon Linux 2023 container, the Web Functions OS —
# the glibc arm64 DuckDB binding and the extensions the images ship.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
DIST=$HERE/dist
CACHE=$HERE/.cache
NODE_VERSION=${NODE_VERSION:-24.22.0}
DUCKDB_NODE_API=$(jq -r '.dependencies["@duckdb/node-api"]' "$ROOT/packages/api/package.json")

rm -rf "$DIST" && mkdir -p "$DIST" "$CACHE"

# The query child as the images carry it (packages/api's build bundles it)
# Not rebuilt here: `pnpm dev` may be using these dists. Build them by hand when stale.
for f in packages/api/dist/services/query/query-child.mjs packages/lake/dist/index.js packages/shared/dist/index.js; do
  [ -s "$ROOT/$f" ] || { echo "missing $f: run pnpm --filter @kukan/api... build"; exit 1; }
done
cp "$ROOT/packages/api/dist/services/query/query-child.mjs" "$DIST/"
# KUKAN's migrations, which stage 2b's /migrate applies for stage 2c's web
cp -r "$ROOT/packages/db/drizzle" "$DIST/drizzle"

# The server, from the real modules; DuckDB stays external like the child's
# The AWS SDK, pg and the Secrets Manager client resolve from the packages that carry them
NODE_PATH="$ROOT/packages/adapters/storage/node_modules:$ROOT/packages/db/node_modules:$(ls -d "$ROOT"/node_modules/.pnpm/@aws-sdk+client-secrets-manager@*/node_modules | tail -1)" "$ROOT/packages/api/node_modules/.bin/esbuild" "$HERE/server.ts" \
  --bundle --platform=node --format=esm --target=node24 \
  --external:@duckdb/node-api \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$DIST/server.mjs" --log-level=warning
printf '{ "name": "kukan-probe-duckdb", "private": true, "type": "module" }\n' > "$DIST/package.json"
[ -s "$HERE/token.txt" ] || openssl rand -hex 16 > "$HERE/token.txt"
cp "$HERE/token.txt" "$DIST/"
# The RDS CA bundle for the Region, which stage 2b's /db verifies the server with
# (.crt, not .pem: `aws lambda-web deploy` leaves *.pem out of the package)
curl -fsSLo "$DIST/rds-ca.crt" "https://truststore.pki.rds.amazonaws.com/ap-northeast-1/ap-northeast-1-bundle.pem"

# Native parts on the target's own OS and architecture
[ -s "$CACHE/node-v$NODE_VERSION-linux-arm64.tar.gz" ] ||
  curl -fsSLo "$CACHE/node-v$NODE_VERSION-linux-arm64.tar.gz" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.gz"
docker run --rm --platform linux/arm64 \
  -v "$DIST:/out" -v "$CACHE:/cache:ro" -w /out \
  -e NODE_VERSION="$NODE_VERSION" -e DUCKDB_NODE_API="$DUCKDB_NODE_API" \
  public.ecr.aws/amazonlinux/amazonlinux:2023 bash -euo pipefail -c '
    dnf install -y -q tar gzip >/dev/null
    tar -xzf /cache/node-v$NODE_VERSION-linux-arm64.tar.gz -C /usr/local --strip-components=1
    npm install --no-audit --no-fund --omit=dev --loglevel=error "@duckdb/node-api@$DUCKDB_NODE_API" >/dev/null
    rm -f package-lock.json
    node --input-type=module -e "
      const { DuckDBInstance } = await import(\"@duckdb/node-api\");
      const i = await DuckDBInstance.create(\":memory:\", { extension_directory: \"/out/duckdb-extensions\" });
      const c = await i.connect();
      for (const e of [\"httpfs\", \"aws\", \"sqlite\", \"ducklake\"]) { await c.run(\"INSTALL \" + e); await c.run(\"LOAD \" + e) }
      const r = await c.runAndReadAll(\"SELECT version() v, (SELECT platform FROM pragma_platform()) p\");
      console.log(JSON.stringify(r.getRowObjectsJson()[0]));
    "
    ls node_modules/@duckdb
    chown -R '"$(id -u):$(id -g)"' /out
  '
du -sh "$DIST" "$DIST/node_modules" "$DIST/duckdb-extensions"
(cd "$DIST" && zip -qr -X /tmp/kukan-probe-duckdb-size.zip . && ls -l /tmp/kukan-probe-duckdb-size.zip | awk '{print "zip bytes:", $5}' && rm /tmp/kukan-probe-duckdb-size.zip)
