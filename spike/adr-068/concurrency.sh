#!/usr/bin/env bash
# How many requests an endpoint takes at once: bursts of N parallel requests that each
# hold for HOLD_MS, against maxEnvironments=MAX_ENVS. Prints 200s, 429s and the error types.
# ADR-068 §Decision 8. Uses the stage 1 probe (kukan-probe) and its token.
set -uo pipefail
cd "$(dirname "$0")"
NAME=${PROBE_NAME:-kukan-probe}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}
MAX_ENVS=${MAX_ENVS:-2}
HOLD_MS=${HOLD_MS:-2000}
ROUNDS=${ROUNDS:-2}
STEPS=${STEPS:-8 16 32 64 96 128}
aws lambda-web update-web-function-endpoint --region "$REGION" --function-name "$NAME" --endpoint-name dev \
  --scaling-config "maxEnvironments=$MAX_ENVS" >/dev/null
until [ "$(aws lambda-web get-web-function-endpoint --region "$REGION" --function-name "$NAME" \
  --endpoint-name dev --query updateStatus --output text)" = Successful ]; do sleep 3; done
DOMAIN=$(aws lambda-web get-web-function-endpoint --region "$REGION" --function-name "$NAME" \
  --endpoint-name dev --query domainName --output text)
TOKEN=$(cat probe/token.txt)
echo "maxEnvironments=$MAX_ENVS hold=${HOLD_MS}ms"
for round in $(seq "$ROUNDS"); do
  for n in $STEPS; do
    out=$(seq "$n" | xargs -P "$n" -I{} curl -s -m 30 -o /dev/null -D - -H "x-probe-token: $TOKEN" \
      "https://$DOMAIN/sleep?ms=$HOLD_MS" 2>/dev/null | tr -d '\r' | grep -iE '^HTTP/|^lambda-web-error-type')
    ok=$(grep -c ' 200' <<<"$out"); thr=$(grep -c ' 429' <<<"$out")
    types=$(grep -i '^lambda-web-error-type' <<<"$out" | sort | uniq -c | awk '{printf "%s×%s ", $1, $3}')
    echo "round $round  n=$n  200=$ok  429=$thr  $types"
    sleep 2
  done
done
