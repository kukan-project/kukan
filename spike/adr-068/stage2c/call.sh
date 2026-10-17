#!/usr/bin/env bash
# Signed request to kukan-probe-web: call.sh <path> [METHOD] [json body]
set -euo pipefail
cd "$(dirname "$0")"
REGION=${REGION:-ap-northeast-1}
DOMAIN=$(aws lambda-web get-web-function-endpoint --region "$REGION" --function-name "${PROBE_NAME:-kukan-probe-web}" \
  --endpoint-name dev --query domainName --output text)
eval "$(aws configure export-credentials --format env)"
SIGV4_MODULE=$(ls -d "$PWD"/../../../node_modules/.pnpm/@smithy+signature-v4@*/node_modules/@smithy/signature-v4/package.json | tail -1) \
  AWS_REGION=$REGION node call.mjs "https://$DOMAIN$1" "${@:2}"
