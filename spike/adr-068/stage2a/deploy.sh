#!/usr/bin/env bash
# Deploy dist/ (from build.sh) as a Web Function in Tokyo. AWS_PROFILE picks the account.
set -euo pipefail
cd "$(dirname "$0")"
NAME=${PROBE_NAME:-kukan-probe-duckdb}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}
[ -s dist/server.mjs ] || { echo "run ./build.sh first"; exit 1; }
aws lambda-web deploy --name "$NAME" --code ./dist --region "$REGION" --create \
  --env AWS_LAMBDA_NODEJS_ENTRYPOINT=server.mjs \
  --env DUCKDB_EXTENSION_DIRECTORY=/var/task/duckdb-extensions \
  --env QUERY_CHILD_ENTRY=/var/task/query-child.mjs \
  --timeout-seconds 120 --max-environments 10 --rate-limit 100 --tags project=kukan-probe \
  ${DEPLOY_EXTRA_ARGS:-}
