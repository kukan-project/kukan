#!/usr/bin/env bash
# delete-web-function leaves the role, the packages and the log groups behind; remove them too.
set -uo pipefail
NAME=${PROBE_NAME:-kukan-probe}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws lambda-web delete-web-function --function-name "$NAME" --region "$REGION"
ROLE=awscli-lambdaweb-$NAME
for p in $(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[]' --output text); do
  aws iam delete-role-policy --role-name "$ROLE" --policy-name "$p"
done
aws iam delete-role --role-name "$ROLE"
# Two groups per function: the regional one and "<name>.local"
for g in "/aws/lambda/web/$NAME" "/aws/lambda/web/$NAME.local"; do
  aws logs delete-log-group --region "$REGION" --log-group-name "$g" && echo "deleted $g"
done
# Packages: this function's, and any extra prefixes named in EXTRA_PREFIXES
BUCKET=awscli-lambdaweb-$ACCOUNT-$REGION-an
VERSIONS=$(mktemp)
for prefix in "lambda-web/$NAME/" ${EXTRA_PREFIXES:-}; do
  aws s3api list-object-versions --bucket "$BUCKET" --prefix "$prefix" \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json > "$VERSIONS"
  grep -q '"Key"' "$VERSIONS" &&
    aws s3api delete-objects --bucket "$BUCKET" --delete "file://$VERSIONS" >/dev/null && echo "deleted s3://$BUCKET/$prefix"
done
rm -f "$VERSIONS"
# The bucket is shared by every `deploy` in this account and Region: remove it only when empty
if [ "$(aws s3api list-object-versions --bucket "$BUCKET" --max-items 1 --query 'length([Versions, DeleteMarkers][][])' --output text)" = "0" ]; then
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" && echo "deleted bucket $BUCKET (empty)"
else
  echo "bucket $BUCKET kept: other packages remain"
fi
