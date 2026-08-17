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
 * Separate accounts are RECOMMENDED for prd (isolation, blast radius, billing,
 * IAM boundary — ADR-031). Same-account is fully supported for evaluation / small
 * / cost-conscious setups, with one caveat: deploying the same commit to two envs
 * in one account near-simultaneously can hit an ECR asset-tag push conflict
 * (transient and retry-safe — see docs/specs/en/phase4-deploy.md).
 *
 * This example presents the multi-site shape only (ADR-041): every environment
 * declares `sites`, starting with a single entry, because `sites` cannot be
 * added to an already-deployed single-site environment later (that path is a
 * blue/green migration). An environment without `sites` still synthesizes the
 * classic all-in-one single-site stack — the site-scoped fields below then
 * live on the environment entry (see docs/specs/en/phase4-deploy.md).
 *
 * Where each field goes:
 *   - Environment entry ONLY (the shared boxes + CI/CD):
 *       account, region, scale, dbEngine, enableOpenSearch, bedrock,
 *       githubRepo, deployBranch
 *   - Site entries ONLY (rejected on the environment entry):
 *       name, brand, domainName, hostedZoneId, hostedZoneName, certificateArn,
 *       webAclArn, enableWaf, allowedIpRanges, basicAuth, bucketName,
 *       enableGa4DataApi
 *       (the type still accepts these on the environment entry, but ONLY as
 *       the legacy single-site shape without `sites`. Mixing the shapes —
 *       `sites` plus env-level site fields — is invalid and rejected at synth)
 *   - BOTH: `overrides` — the environment level tunes every section (including
 *     the shared db/opensearch and the backup schedule); a site may only tune
 *     its own sections (web / worker / dbPool / backup S3 settings), deep-merged
 *     on top of the environment's.
 *
 * Custom domain / WAF in PIPELINE mode (ADR-030):
 *   CDK Pipelines is incompatible with cross-region references, so the us-east-1
 *   ACM certificates and WAF WebACL cannot be created inside the pipeline
 *   (standalone deploys auto-create the missing ones). Create them once via a
 *   standalone deploy, then paste the ARNs into the site entries:
 *     npx cdk deploy -c env=prd Prd/KukanGlobalStack
 *   WAF defaults ON (secure by default, ADR-027); set `enableWaf: false` or
 *   supply `webAclArn` per site to use pipeline mode.
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

    // --- Sizing (the shared boxes) ---
    scale: 'small', // 'small' | 'medium' | 'large'
    // dbEngine: 'rds', // omit → scale default (small=rds, medium/large=aurora)
    // enableOpenSearch: true, // false → PostgreSQL full-text fallback

    // --- Fine-tuning (deep-merged onto the scale preset, then under each site's overrides) ---
    // overrides: {
    //   // Scaling
    //   web: { maxSize: 5 },
    //   opensearch: { instanceCount: 2, indexReplicas: 1 },
    //   // Backup (ADR-037). Presets: small = 7-day DB retention only; medium adds
    //   // S3 versioning + 14 days; large = 35 days + AWS Backup (daily 35d + monthly 12mo).
    //   // The DB plan runs once in the SharedStack, bucket plans per site (ADR-041)
    //   backup: {
    //     s3Versioning: true, // required when awsBackup is set
    //     dbBackupRetentionDays: 35, // PITR window, days (1–35)
    //     awsBackup: { dailyRetentionDays: 35, monthlyRetentionMonths: 12 }, // isolated vault
    //   },
    // },

    // --- AI (Bedrock: semantic search ADR-034 + metadata suggestions ADR-040) ---
    // Presence enables it. Amazon models (Titan v2 embedding, the default Nova Lite
    // completion) work on first invocation; Anthropic models (Claude, only if you add
    // them to completionModels) need a one-time per-account step: submit the Anthropic
    // use-case form in the Bedrock console.
    // (The Model access page is retired — serverless models auto-enable on first
    // invoke; Marketplace models like Cohere need the one-time invoke below.)
    // `bedrock: false` opts out (AI_TYPE=none).
    // One `bedrock` object with the fields you want to override:
    // bedrock: {
    //   vectorMinSimilarity: 0.2, // similarity floor override — omit → model default (Titan 0.15 / Cohere 0.3, ADR-034)
    //   // Stronger Japanese retrieval (measured nDCG 75 vs Titan 70): Cohere Embed v4.
    //   // Marketplace model — an admin must invoke it once to subscribe the account,
    //   // then reindex to re-embed:
    //   //   aws bedrock-runtime invoke-model --region ap-northeast-1 \
    //   //     --model-id cohere.embed-v4:0 --content-type application/json \
    //   //     --body '{"texts":["test"],"input_type":"search_document"}' /dev/stdout
    //   embeddingModel: 'cohere.embed-v4:0',
    //   // AI-suggestion completion models (ADR-040): the task role is granted InvokeModel
    //   // on exactly these and they become the admin model-picker options. The first
    //   // entry is the provider default (a Nova-only list is fine). Omit → the default
    //   // jp. Nova Lite profile only. Use region-appropriate profiles (jp.* stays in Japan):
    //   completionModels: ['jp.amazon.nova-2-lite-v1:0', 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'],
    // },

    // --- CI/CD (pipeline mode) ---
    githubRepo: 'kukan-project/your-repo', // CodeConnections source repo (owner/repo)
    deployBranch: 'develop', // branch that deploys this env

    // --- Sites (ADR-041): resources kukan-dev-<site>-*, database kukan_<site> ---
    sites: [
      {
        name: 'main', // ^[a-z][a-z0-9]{1,15}$ (used in resource names AND PostgreSQL identifiers)

        // --- Security (edge gate, per site) ---
        enableWaf: false, // omit → ON unless allowedIpRanges or basicAuth is set (ADR-027)
        // allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
        // Basic auth gate, OR-combined with allowedIpRanges (light gate only — ADR-027):
        // basicAuth: { username: 'preview', password: 'change-me' },

        // --- Custom domain (standalone: cert auto-created from the hosted zone;
        //     pipeline: paste the us-east-1 ARNs — see the header) ---
        // domainName: 'dev.example.com',
        // hostedZoneId: 'Z0123456789',
        // hostedZoneName: 'example.com',
        // certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/...',
        // webAclArn: 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/...', // sharable across sites

        // --- Misc ---
        // brand: 'my-brand', // web image brand; unset → default brand src/brand (needs apps/web/brands/my-brand/, ADR-042)
        // bucketName: 'my-resource-bucket', // omit → CDK auto-naming (globally unique)
        // enableGa4DataApi: false,
        // overrides: { web: { maxSize: 2 }, dbPool: { webMax: 5 } }, // site-owned sections only
      },
    ],
  },

  // `prd` shows a typical production environment. Add sites as they onboard —
  // the first site is the deploy canary, sites deploy serially, and only sites
  // whose image content changed actually roll.
  prd: {
    account: '000000000000', // REQUIRED: target AWS account ID (misdeployment guard)
    scale: 'large',
    githubRepo: 'kukan-project/your-repo',
    deployBranch: 'main',
    // overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
    sites: [
      { name: 'main', enableWaf: false }, // pipeline mode: WAF on needs a pasted webAclArn
      // {
      //   name: 'citya',
      //   domainName: 'catalog.city-a.example.jp',
      //   hostedZoneId: 'Z0123456789',
      //   hostedZoneName: 'city-a.example.jp',
      //   certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/...', // pipeline only
      //   webAclArn: 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/...', // sharable
      //   overrides: { web: { maxSize: 10 } },
      // },
      // { name: 'cityb', enableWaf: false, basicAuth: { username: 'preview', password: '...' } },
    ],
  },
} satisfies Record<string, EnvironmentConfig>
