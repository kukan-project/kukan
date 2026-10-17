#!/usr/bin/env bash
# Assemble the whole web (Next.js standalone) for a Web Function in dist/, and zip it.
#
# WEB_WORKTREE is a worktree of this repository where the web was built with the
# glibc arm64 binaries installed beside the host's (README: "Stage 2c"), so the
# standalone trace carries @duckdb/node-bindings-linux-arm64 and @img/sharp-linux-arm64.
# The DuckDB extensions come from ../stage2a/dist (same DuckDB version).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WT=$(cd "${WEB_WORKTREE:?set WEB_WORKTREE to the build worktree}" && pwd)
S=$WT/apps/web/.next/standalone
DIST=$HERE/dist
[ -d "$S" ] || { echo "no standalone output in $WT"; exit 1; }
[ -d "$HERE/../stage2a/dist/duckdb-extensions" ] || { echo "run ../stage2a/build.sh first"; exit 1; }

rm -rf "$DIST" "$HERE/web.zip" && mkdir -p "$DIST"
# As the image lays it out (Dockerfile, web stage); -a keeps pnpm's symlinks
cp -a "$S/." "$DIST/"
cp -a "$WT/apps/web/.next/static" "$DIST/apps/web/.next/static"
cp -a "$WT/apps/web/public" "$DIST/apps/web/public"
cp "$WT/packages/api/dist/services/query/query-child.mjs" "$DIST/node_modules/.pnpm/kukan-query-child.mjs"
cp -a "$HERE/../stage2a/dist/duckdb-extensions" "$DIST/duckdb-extensions"

# Only the target's binaries: glibc arm64
rm -rf "$DIST"/node_modules/.pnpm/@duckdb+node-bindings-linux-x64@* \
  "$DIST"/node_modules/.pnpm/@img+sharp-linux-x64@* "$DIST"/node_modules/.pnpm/@img+sharp-libvips-linux-x64@*
find "$DIST" -xtype l -delete
# The trace takes the addon but not libduckdb.so; duckdb.node finds it beside itself ($ORIGIN)
B=$(ls -d "$DIST"/node_modules/.pnpm/@duckdb+node-bindings-linux-arm64@*/node_modules/@duckdb/node-bindings-linux-arm64)
cp "$(ls -d "$WT"/node_modules/.pnpm/@duckdb+node-bindings-linux-arm64@*/node_modules/@duckdb/node-bindings-linux-arm64)/libduckdb.so" "$B/"

# Next's standalone server reads HOSTNAME and PORT; Lambda gives one host:port
cat > "$DIST/lambda.mjs" <<'JS'
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '0.0.0.0:3000').split(':')
process.env.HOSTNAME = host
process.env.PORT = port
await import('./apps/web/server.js')
JS

du -sh "$DIST" "$DIST/node_modules" "$DIST/duckdb-extensions" "$DIST/apps"
(cd "$DIST" && zip -qry -X "$HERE/web.zip" .)
ls -l "$HERE/web.zip" | awk '{print "zip bytes:", $5}'
