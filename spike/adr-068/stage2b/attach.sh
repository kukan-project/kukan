#!/usr/bin/env bash
# Put kukan-probe-duckdb on the stage 2b network: deploy the current dist/ with the
# DB settings, then a revision of it that references the connector's pinned version.
# Needs the kukan-probe-vpc stack (network.yaml) and AWS_PROFILE.
set -euo pipefail
cd "$(dirname "$0")"
NAME=${PROBE_NAME:-kukan-probe-duckdb}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name kukan-probe-vpc \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CONNECTOR=$(out ConnectorVersionArn)
DB_HOST=$(out DbHost)
DB_SECRET_ARN=$(out DbSecretArn)
echo "connector: $CONNECTOR"

# The one secret it reads, and nothing else
aws iam put-role-policy --role-name "awscli-lambdaweb-$NAME" --policy-name read-db-secret \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$DB_SECRET_ARN\"}]}"

DEPLOY_EXTRA_ARGS="--env DB_HOST=$DB_HOST --env DB_SECRET_ARN=$DB_SECRET_ARN" ../stage2a/deploy.sh |
  grep -v 'state Pending'

# deploy has no connector option: copy the newest revision and add one
latest=$(aws lambda-web list-web-function-revisions --region "$REGION" --function-name "$NAME" \
  --query 'sort_by(revisions, &createdAt)[-1].revisionId' --output text)
rev=$(aws lambda-web get-web-function-revision --region "$REGION" --function-name "$NAME" \
  --revision-id "$latest" --output json)
new=$(aws lambda-web create-web-function-revision --region "$REGION" --function-name "$NAME" \
  --build-config "$(jq -c .buildConfig <<<"$rev")" \
  --service-config "$(jq -c --arg c "$CONNECTOR" '.serviceConfig + {egressNetworkConnectorArn: $c}' <<<"$rev")" \
  --query revisionId --output text)
echo "revision with connector: $new (copied from $latest)"
aws lambda-web wait web-function-revision-active --region "$REGION" --function-name "$NAME" --revision-id "$new"
echo "active; the dev endpoint (LatestRevision) routes to it"
