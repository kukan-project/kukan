/**
 * KUKAN environment definitions (EXAMPLE / committed template — ADR-031).
 *
 * Copy this file to `environments.ts` and edit it for your fork:
 *
 *   cp infra/config/environments.example.ts infra/config/environments.ts
 *
 * Forks commit their `environments.ts`; upstream does not — this example is the
 * fallback. On a fresh upstream checkout: `pnpm typecheck` works unconditionally;
 * `cdk synth` additionally needs AWS credentials (to resolve context lookups) or a
 * committed `cdk.context.json`.
 *
 * Same-account vs separate-account is chosen purely here:
 *   - omit `account`            → CDK_DEFAULT_ACCOUNT (same-account operation)
 *   - set `account` per env     → separate-account operation
 *
 * Custom domain / WAF in PIPELINE mode (ADR-030):
 *   CDK Pipelines is incompatible with cross-region references, so the us-east-1
 *   ACM certificate and WAF WebACL cannot be created inside the pipeline. Create them
 *   once via a standalone deploy, then paste their ARNs here:
 *     npx cdk deploy -c env=prd Prd/KukanGlobalStack
 *   and set `certificateArn` / `webAclArn` below. WAF defaults ON (secure by default,
 *   ADR-027); set `enableWaf: false` or supply `webAclArn` to use pipeline mode.
 */

import type { EnvironmentConfig } from '../lib/config.js'

/**
 * CodeConnections connection ARN (ADR-030).
 * Create the connection once in the AWS console (approve the GitHub App "AWS Connector")
 * and paste its ARN here.
 */
export const connectionArn =
  'arn:aws:codeconnections:ap-northeast-1:000000000000:connection/REPLACE_ME'

// IMPORTANT: every entry here becomes its own environment — in pipeline mode each one
// gets its own CodePipeline and is deployed (on its `deployBranch`). Keep only the
// environments you actually want. For a single environment, delete the others (e.g.
// remove `dev` and keep only `prd`).
export const environments = {
  // `dev` below documents every available field (optional ones commented out).
  dev: {
    // --- Target AWS environment ---
    account: '000000000000', // REQUIRED: target AWS account ID (misdeployment guard — CDK
    //                          refuses to deploy if your credentials are for another account)
    // region: 'ap-northeast-1', // omit → ap-northeast-1

    // --- Sizing ---
    scale: 'small', // 'small' | 'medium' | 'large'
    // dbEngine: 'rds', // omit → scale default (small=rds, medium/large=aurora)
    // enableOpenSearch: true, // false → PostgreSQL full-text fallback

    // --- Fine-tuning (one `overrides` object, deep-merged onto the scale preset) ---
    // overrides: {
    //   // Scaling
    //   web: { maxSize: 5 },
    //   opensearch: { instanceCount: 2, indexReplicas: 1 },
    //   // Backup (ADR-037). Presets: small = 7-day DB retention only; medium adds
    //   // S3 versioning + 14 days; large = 35 days + AWS Backup (daily 35d + monthly 12mo)
    //   backup: {
    //     s3Versioning: true, // required when awsBackup is set
    //     dbBackupRetentionDays: 35, // PITR window, days (1–35)
    //     awsBackup: { dailyRetentionDays: 35, monthlyRetentionMonths: 12 }, // isolated vault
    //   },
    // },

    // --- Security ---
    enableWaf: false, // omit → ON unless allowedIpRanges or basicAuth is set (ADR-027)
    // allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
    // Basic auth gate, OR-combined with allowedIpRanges (light gate only — ADR-027):
    // basicAuth: { username: 'preview', password: 'change-me' },

    // --- Custom domain (for pipeline mode, also supply the us-east-1 ARNs below) ---
    // domainName: 'dev.example.com',
    // hostedZoneId: 'Z0123456789',
    // hostedZoneName: 'example.com',
    // certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/...',
    // webAclArn: 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/...',

    // --- Misc ---
    // bucketName: 'my-resource-bucket', // omit → CDK auto-naming (globally unique)
    // enableGa4DataApi: false,
    // Semantic search via Bedrock embeddings (ADR-034). Default ON — Titan v2,
    // auto-enabled on first invocation, no console setup. Similarity floors are
    // measured per model and applied by the app automatically (Titan v2 0.15 /
    // Cohere v4 0.3 — see ADR-034 "Evaluation Results").
    // bedrock: false, // opt out (AI_TYPE=none)
    // bedrock: { vectorMinSimilarity: 0.2 }, // override the model's measured floor
    //
    // Stronger Japanese retrieval (measured nDCG 75 vs Titan 70, question-form
    // queries +5-12pt): Cohere Embed v4. Marketplace model — BEFORE deploying, an
    // admin must invoke it once to subscribe the account, then allow a few minutes
    // to propagate; reindex afterwards to re-embed:
    //   aws bedrock-runtime invoke-model --region ap-northeast-1 \
    //     --model-id cohere.embed-v4:0 --content-type application/json \
    //     --body '{"texts":["test"],"input_type":"search_document"}' /dev/stdout
    // bedrock: { embeddingModel: 'cohere.embed-v4:0' },

    // --- CI/CD (pipeline mode) ---
    githubRepo: 'kukan-project/your-repo', // CodeConnections source repo (owner/repo)
    deployBranch: 'develop', // branch that deploys this env
  },

  // `prd` shows a typical production env with a custom domain + IP allowlist.
  prd: {
    account: '000000000000', // REQUIRED: target AWS account ID (misdeployment guard)
    scale: 'large',
    enableWaf: false,
    githubRepo: 'kukan-project/your-repo',
    deployBranch: 'main',
    // domainName: 'catalog.example.com',
    // hostedZoneId: 'Z0123456789',
    // hostedZoneName: 'example.com',
    // allowedIpRanges: ['203.0.113.0/24'], // WAF auto-off when set (SG/CF Function protects)
    // certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/...', // pipeline: create once
    // webAclArn: 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/...',
    // overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
  },
} satisfies Record<string, EnvironmentConfig>
