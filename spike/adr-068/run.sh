#!/usr/bin/env bash
# Hit each route and keep the replies in results/ (raw data; not to be committed).
set -uo pipefail
cd "$(dirname "$0")"
: "${ENDPOINT:?set ENDPOINT=https://<domain>}"
H="x-probe-token: $(cat probe/token.txt)"
OUT=results/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
get() { # name path
  echo "== $1"
  curl -sS -m 120 -D "$OUT/$1.headers" -H "$H" "$ENDPOINT$2" -o "$OUT/$1.json" \
    -w "status=%{http_code} total=%{time_total}s\n"
}
get probe /probe
get fork /fork
get tmp-256 '/tmp?mb=256'
get tmp-600 '/tmp?mb=600'         # past the documented 512 MB
for m in 256 1024 1536 1900 2300; do  # last two near / past the 2 GB environment
  get "alloc-$m" "/alloc?mb=$m"
done
get probe-after /probe            # same pid and uptime = the parent survived the allocations
echo "results: $OUT"
