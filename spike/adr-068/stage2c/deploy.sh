#!/usr/bin/env bash
# Create (or update) kukan-probe-web from web.zip: its own role, the zip uploaded
# as-is (symlinks kept, which the deploy command's packaging may not), the
# connector from kukan-probe-vpc, and an IamAuth endpoint — the first account to
# register on an empty KUKAN becomes sysadmin (ADR-038), so it is not public.
set -euo pipefail
cd "$(dirname "$0")"
NAME=${PROBE_NAME:-kukan-probe-web}  # not $NAME: VS Code terminals set it
REGION=${REGION:-ap-northeast-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CODE_BUCKET=awscli-lambdaweb-$ACCOUNT-$REGION-an
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name kukan-probe-vpc \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CONNECTOR=$(out ConnectorVersionArn)
DB_HOST=$(out DbHost)
DB_SECRET_ARN=$(out DbSecretArn)
DATA=$(out DataBucket)
ROLE=kukan-probe-web

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --tags Key=project,Value=kukan-probe --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  sleep 10 # IAM propagation before Lambda assumes it
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name web --policy-document "$(jq -nc \
  --arg data "arn:aws:s3:::$DATA" --arg secret "$DB_SECRET_ARN" '{Version: "2012-10-17", Statement: [
    {Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*"},
    {Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], Resource: [$data, ($data + "/*")]},
    {Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: $secret}]}')"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

KEY=lambda-web/$NAME/web-$(date +%Y%m%dT%H%M%S).zip
VERSION=$(aws s3api put-object --bucket "$CODE_BUCKET" --key "$KEY" --body web.zip --query VersionId --output text)

# The spike passes the password in the environment (encrypted at rest); ADR-068 §Decision 5
# has the web fetch it at startup instead, which KUKAN does not do yet.
DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --query SecretString --output text | jq -r .password)
[ -s .auth-secret ] || openssl rand -hex 32 > .auth-secret
DOMAIN=$(aws lambda-web get-web-function-endpoint --region "$REGION" --function-name "$NAME" \
  --endpoint-name dev --query domainName --output text 2>/dev/null || true)
ENV=$(jq -nc --arg host "$DB_HOST" --arg pw "$DB_PASSWORD" --arg data "$DATA" --arg region "$REGION" \
  --arg auth "$(cat .auth-secret)" --arg url "${DOMAIN:+https://$DOMAIN}" '{
  AWS_LAMBDA_NODEJS_ENTRYPOINT: "lambda.mjs", NODE_ENV: "production",
  POSTGRES_HOST: $host, POSTGRES_PASSWORD: $pw, POSTGRES_SSLMODE: "require",
  S3_BUCKET: $data, S3_REGION: $region, SEARCH_TYPE: "postgres", WEB_DB_POOL_MAX: "5",
  BETTER_AUTH_SECRET: $auth,
  QUERY_CHILD_ENTRY: "/var/task/node_modules/.pnpm/kukan-query-child.mjs",
  DUCKDB_EXTENSION_DIRECTORY: "/var/task/duckdb-extensions"} + (if $url == "" then {} else {BETTER_AUTH_URL: $url} end)')
REVISION=$(jq -nc --arg b "$CODE_BUCKET" --arg k "$KEY" --arg v "$VERSION" --arg role "$ROLE_ARN" \
  --arg c "$CONNECTOR" --argjson env "$ENV" '{
  buildConfig: {codeConfig: {s3Object: {bucket: $b, key: $k, versionId: $v}}, runtimeConfig: {runtime: "nodejs24.x"}},
  serviceConfig: {executionRoleArn: $role, timeoutSeconds: 60, egressNetworkConnectorArn: $c, environmentVariables: $env}}')

if aws lambda-web get-web-function --region "$REGION" --function-name "$NAME" >/dev/null 2>&1; then
  rev=$(aws lambda-web create-web-function-revision --region "$REGION" --function-name "$NAME" \
    --build-config "$(jq -c .buildConfig <<<"$REVISION")" --service-config "$(jq -c .serviceConfig <<<"$REVISION")" \
    --query revisionId --output text)
else
  rev=$(aws lambda-web create-web-function --region "$REGION" --function-name "$NAME" --tags project=kukan-probe \
    --revision-config "$REVISION" --endpoint-config '{"endpointName": "dev", "endpointType": "HomeRegion",
      "authType": "IamAuth", "autoDeploymentMode": "LatestRevision",
      "scalingConfig": {"maxEnvironments": 10}, "throttleConfig": {"rateLimit": 100}}' \
    --query 'revision.revisionId' --output text 2>&1) || { echo "$rev"; exit 1; }
fi
echo "revision: $rev"
aws lambda-web wait web-function-revision-active --region "$REGION" --function-name "$NAME" --revision-id "$rev"
aws lambda-web get-web-function-endpoint --region "$REGION" --function-name "$NAME" --endpoint-name dev \
  --query '{domain: domainName, state: state}' --output json
[ -n "$DOMAIN" ] || echo "first deploy: run again so BETTER_AUTH_URL names the endpoint"
