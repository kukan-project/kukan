#!/usr/bin/env bash
# Stage 2a: KUKAN's query child and in-process DuckDB against presigned Parquet.
# Needs ENDPOINT, AWS_PROFILE, and the files under s3://<bucket>/spike-data/ (see README).
set -uo pipefail
cd "$(dirname "$0")"
: "${ENDPOINT:?set ENDPOINT=https://<domain>}"
REGION=${REGION:-ap-northeast-1}
BUCKET=${BUCKET:-awscli-lambdaweb-$(aws sts get-caller-identity --query Account --output text)-$REGION-an}
H="x-probe-token: $(cat token.txt)"
OUT=results/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
# Keys, not URLs: the function signs with its own role, as the web signs with its task role
# (a URL signed here can carry conditions of the caller's own, such as a source IP)
SMALL=spike-data/small.parquet
LARGE=spike-data/large.parquet
state() { echo "== $1"; curl -sS -m 130 -H "$H" "$ENDPOINT/state" -o "$OUT/$1.json" -w "status=%{http_code} total=%{time_total}s\n"; }
q() { # name path(with query) key sql
  echo "== $1"
  jq -n --arg bucket "$BUCKET" --arg key "$3" --arg sql "$4" '{bucket: $bucket, key: $key, sql: $sql}' |
    curl -sS -m 130 -H "$H" -H 'content-type: application/json' --data-binary @- \
      -D "$OUT/$1.headers" "$ENDPOINT$2" -o "$OUT/$1.json" -w "status=%{http_code} total=%{time_total}s\n"
}
state state-cold
q small-count /query "$SMALL" 'SELECT count(*) n, avg(score) s FROM data'
q small-count-warm /query "$SMALL" 'SELECT count(*) n, avg(score) s FROM data'
q large-city /query "$LARGE" 'SELECT city, count(*) n, avg(score) s FROM data GROUP BY city ORDER BY city'
q large-h1 /query "$LARGE" 'SELECT h1, count(*) n FROM data GROUP BY h1 ORDER BY n DESC, h1 LIMIT 5'
q large-sort /query "$LARGE" 'SELECT * FROM data ORDER BY h2 LIMIT 5'
# Past the budget on purpose: DuckDB allowed 1.5 GB, the parent's RSS budget unchanged
q large-overbudget '/query?memMb=1500&threads=2' "$LARGE" 'SELECT h1, h2, label, count(*) n FROM data GROUP BY ALL ORDER BY n DESC LIMIT 5'
state state-after-overbudget
q inproc-small /inproc "$SMALL" 'SELECT count(*) n, avg(score) s FROM data'
q inproc-large '/inproc?memMb=512' "$LARGE" 'SELECT city, count(*) n, avg(score) s FROM data GROUP BY city ORDER BY city'
state state-end
echo "results: $OUT"
