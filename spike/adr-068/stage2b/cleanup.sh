#!/usr/bin/env bash
# Remove stage 2 entirely: the web (2c) and DuckDB (2a/2b) probe functions — their
# revisions are what reference the connector, so they go first — then the
# kukan-probe-vpc stack, its data bucket emptied first. The stage 1 function is
# ../cleanup.sh's with its default name.
set -uo pipefail
cd "$(dirname "$0")"
REGION=${REGION:-ap-northeast-1}
PROBE_NAME=kukan-probe-web ../cleanup.sh
# The web's role is not the deploy command's awscli-lambdaweb-<name>
for p in $(aws iam list-role-policies --role-name kukan-probe-web --query 'PolicyNames[]' --output text 2>/dev/null); do
  aws iam delete-role-policy --role-name kukan-probe-web --policy-name "$p"
done
aws iam delete-role --role-name kukan-probe-web 2>/dev/null && echo "deleted role kukan-probe-web"
PROBE_NAME=kukan-probe-duckdb EXTRA_PREFIXES="spike-data/ ${EXTRA_PREFIXES:-}" ../cleanup.sh
DATA=$(aws cloudformation describe-stacks --region "$REGION" --stack-name kukan-probe-vpc \
  --query "Stacks[0].Outputs[?OutputKey=='DataBucket'].OutputValue" --output text)
[ -n "$DATA" ] && [ "$DATA" != None ] && aws s3 rm --quiet --recursive "s3://$DATA" && echo "emptied s3://$DATA"
aws cloudformation delete-stack --region "$REGION" --stack-name kukan-probe-vpc
echo "waiting for kukan-probe-vpc to delete (RDS takes several minutes) ..."
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name kukan-probe-vpc && echo deleted
