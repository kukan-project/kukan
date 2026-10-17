#!/usr/bin/env bash
# Deploy the probe as a Web Function in Tokyo. Needs an AWS CLI with `aws lambda-web`.
# AWS_PROFILE picks the account; nothing here names one.
set -euo pipefail
cd "$(dirname "$0")"
NAME=${PROBE_NAME:-kukan-probe}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}

aws lambda-web help >/dev/null 2>&1 || { echo "aws CLI has no lambda-web; run: aws update (or reinstall v2)"; exit 1; }
# The endpoint is public (ApplicationManaged); every route checks this token
[ -s probe/token.txt ] || openssl rand -hex 16 > probe/token.txt
# Capped, with room: a limit of 2 environments returned 429 on bursts (ADR-068 §Decision 8);
# rate limits come in steps of 100
aws lambda-web deploy --name "$NAME" --code ./probe --region "$REGION" --create \
  --timeout-seconds 120 --max-environments 10 --rate-limit 100 --tags project=kukan-probe
echo "token: probe/token.txt"
echo "then: ENDPOINT=https://<domain> ./run.sh"
