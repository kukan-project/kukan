> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase4-deploy.md`](../jp/phase4-deploy.md).

# Phase 4: AWS Deployment & CDK Foundation

> **This is a record of a completed phase.** Later ADRs have changed parts of the implementation,
> so for the current shape see the phase list in `CLAUDE.md` and `docs/pipeline.md`. The file paths
> and step names below are the ones in use at the time.

## Overview

The AWS deployment foundation for publishing the demo environment externally.
The aim is that, once open sourced, users can build their own environment with `cdk deploy`.

## Architecture

```
Route53 ─→ CloudFront (WAF + Cache) ─→ [VPC Origin] ─→ ALB (HTTP) ─→ ECS Fargate "web" (:3000)

                              ┌─── Public Subnets ────┐
                              │  ECS Fargate "web"     │
                              │  ECS Fargate "worker"  │
                              └────────────────────────┘
                              ┌─── Isolated Subnets ──┐
                              │  ALB (internal)        │
                              │  Aurora/RDS PostgreSQL │
                              │  OpenSearch 3.x        │
                              └────────────────────────┘

S3 ← presigned URL (straight from the browser) / read and written by the Worker
SQS ← enqueued by the API → consumed by the Worker (long polling)
```

### Components

| Component | Service                               | Rationale                                                              |
| --------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Web       | ECS Fargate + ALB + CloudFront        | L2 constructs, IP restriction via a CF Function, custom domain support |
| Worker    | ECS Fargate Service                   | SQS long polling, no timeout                                           |
| DB        | RDS PostgreSQL / Aurora Serverless v2 | Switched by a CDK parameter                                            |
| Search    | OpenSearch (VPC)                      | The kuromoji plugin; can fall back to PostgreSQL                       |
| Storage   | S3                                    | Direct browser upload with presigned URLs                              |
| Queue     | SQS + DLQ                             | Within the free tier, same API as ElasticMQ                            |
| WAF       | CloudFront WAF (optional)             | Managed rules (ADR-027)                                                |

## VPC Design

```
VPC (10.0.0.0/16)
├── Public Subnet A (AZ-a)  ← ECS Fargate (web, worker)
├── Public Subnet B (AZ-c)  ← ECS Fargate (web, worker)
├── Isolated Subnet A (AZ-a) ← ALB (internal) / RDS / OpenSearch
└── Isolated Subnet B (AZ-c) ← ALB (internal) / RDS (multi-AZ)
```

- ECS tasks run in the public subnets with `assignPublicIp: true` (no NAT needed)
- The ALB / DB / OpenSearch sit in isolated subnets (no internet access)
- A CloudFront VPC Origin connects directly to the ALB (no public IP needed)
- An S3 Gateway VPC Endpoint (free) optimizes S3 traffic

## Worker Health Check

The health of the SQS polling loop is monitored via the ECS Fargate HTTP health check.

- **Endpoint**: `GET http://localhost:8080/health`
- **Healthy when**: `lastPollAt` is within 60 seconds **OR** `processingJobSince` is set (a job is
  being processed)
- **Unhealthy when**: both are null, or `lastPollAt` is over 60 seconds old and nothing is being
  processed → 503
- **ECS behavior**: 503 × 3 → unhealthy → the task restarts automatically

## Choosing the DB Engine

Switched with the CDK `dbEngine` parameter (`rds` | `aurora`).

|                     | RDS PostgreSQL t4g.micro | Aurora Serverless v2 (0 ACU) |
| ------------------- | ------------------------ | ---------------------------- |
| Monthly (always on) | ~$15                     | ~$73 (0.5 ACU min)           |
| Monthly (4h/day)    | ~$15                     | ~$13                         |
| Monthly (unused)    | ~$15                     | ~$1.20 (storage only)        |
| Cold start          | none                     | ~15 seconds                  |

## Cost Estimates

### Small (demo / PoC): ~$120/month

\* Based on the ap-northeast-1 (Tokyo) region. Excluding tax.

| Service               | Spec                  | USD/month |
| --------------------- | --------------------- | --------- |
| ECS Fargate Web       | 0.25 vCPU / 0.5 GB    | ~$9       |
| ECS Fargate Worker    | 0.25 vCPU / 1 GB      | ~$13      |
| ALB                   | always on (internal)  | ~$18      |
| RDS PostgreSQL        | db.t4g.micro + 20 GB  | ~$22      |
| OpenSearch            | t3.small.search × 1   | ~$43      |
| CloudFront            | VPC origin + transfer | ~$2       |
| Public IPv4           | 2 ECS tasks           | ~$8       |
| S3 + SQS              | minimal               | ~$2       |
| Secrets Manager       | 1 secret              | ~$1       |
| ECR + CloudWatch etc. | minimal               | ~$2       |

Without OpenSearch (SEARCH_TYPE=postgres): ~$77/month
Adding WAF (enableWaf=true): +~$9/month
IP restriction is handled by a CloudFront Function (no extra cost)
Consumption tax (10% in the Japan region) is added on top

### Medium (a single municipality): ~$266/month

| Service                            | Spec                        | USD/month |
| ---------------------------------- | --------------------------- | --------- |
| ECS Fargate Web                    | 0.5 vCPU / 1 GB × 1         | ~$23      |
| ECS Fargate Worker                 | 0.5 vCPU / 1 GB × 1         | ~$23      |
| ALB                                | always on (internal)        | ~$18      |
| Aurora Serverless v2               | 0.5–2 ACU, Single-AZ        | ~$57      |
| OpenSearch                         | m6g.large.search × 1 (50GB) | ~$127     |
| CloudFront                         | VPC origin + transfer       | ~$3       |
| Public IPv4                        | 2 ECS tasks                 | ~$8       |
| S3 + SQS + Secrets + ECR + CW etc. | —                           | ~$7       |

### Large (prefecture / national scale): ~$1,191/month

| Service                            | Spec                              | USD/month |
| ---------------------------------- | --------------------------------- | --------- |
| ECS Fargate Web                    | 1 vCPU / 2 GB × 2                 | ~$90      |
| ECS Fargate Worker                 | 1 vCPU / 2 GB × 2                 | ~$90      |
| ALB                                | always on (internal)              | ~$18      |
| Aurora Serverless v2               | 2–8 ACU, Multi-AZ (Writer+Reader) | ~$444     |
| OpenSearch                         | m6g.xlarge.search × 2 (200GB)     | ~$510     |
| CloudFront                         | VPC origin + transfer             | ~$5       |
| Public IPv4                        | 4 ECS tasks                       | ~$15      |
| WAF (optional)                     | managed rules                     | ~$9       |
| S3 + SQS + Secrets + ECR + CW etc. | —                                 | ~$10      |

## CDK Stack Layout

Two stacks. The global resources for CloudFront (the ACM certificate and the WAF WebACL) are
deployed to us-east-1.

| Stack            | Region         | Purpose                                       |
| ---------------- | -------------- | --------------------------------------------- |
| KukanGlobalStack | us-east-1      | ACM certificate + WAF WebACL (for CloudFront) |
| KukanStack       | ap-northeast-1 | VPC, ECS, RDS, CloudFront etc.                |

KukanGlobalStack is created automatically when a domain name is given or WAF is enabled.

```
infra/
├── bin/app.ts                        # entry point (standalone / pipeline branching)
├── config/
│   ├── environments.example.ts       # environment definition template (committed)
│   └── environments.ts               # environment definitions (committed by the fork; copy and edit the example)
├── lib/
│   ├── kukan-stage.ts                # KukanStage (wraps Global+Main, the env boundary)
│   ├── pipeline-stack.ts             # CDK Pipelines (CodeConnections, one per env)
│   ├── kukan-stack.ts                # the main stack
│   ├── global-stack.ts               # the global stack (us-east-1)
│   ├── config.ts                     # config resolution (EnvironmentConfig / loadConfig)
│   └── constructs/
│       ├── network.ts                # VPC, SG, S3 Endpoint
│       ├── database.ts               # RDS / Aurora + Secrets Manager
│       ├── storage.ts                # S3 bucket (CORS, lifecycle)
│       ├── queue.ts                  # SQS + DLQ
│       ├── search.ts                 # OpenSearch (VPC)
│       ├── web-service.ts            # ECS Fargate + ALB
│       ├── worker-service.ts         # ECS Fargate + Auto Scaling
│       └── waf.ts                    # WAF WebACL (optional)
├── cdk.json
├── package.json
└── tsconfig.json
```

### Environment configuration (environments.ts)

Environments (dev / prd etc.) are defined in `infra/config/environments.ts` (ADR-031).
Copy `environments.example.ts` and edit it. `environments.ts` is **not gitignored — the fork
commits it** (upstream does not). This keeps CodeBuild's synth self-contained within the checkout
(ADR-031).

**Each entry = one environment.** In pipeline mode one pipeline is created per env, each deploying
from its own `deployBranch`. The example defines two, dev and prd, so **if you run a single
environment, delete the entry you do not need (e.g. `dev`)** (leaving it deploys two
environments). Note that removing an env from `environments.ts` does not automatically delete an
already-deployed stack (`cdk destroy` is needed manually).
At deploy time you choose the environment with `-c env=<name>`. Both same-account and
cross-account setups are switched purely by what is written in this file (omitting `account` means
the same account; specifying it means a different one).

```bash
cp infra/config/environments.example.ts infra/config/environments.ts
# edit environments.ts
```

The full field list (types, defaults, whether it is env-scoped or site-scoped, and notes on
backwards compatibility) is consolidated in the **environment configuration reference** in the
public documentation
(`site/src/content/docs/ja/system-admin-guide/environment-config.mdx`, published at
<https://kukan-project.github.io/ja/system-admin-guide/environment-config/>).
`environments.example.ts` also lists every field with comments (presenting only the recommended
multi-site shape).

The key point: writing site-scoped fields (`enableWaf` through `enableGa4DataApi`) directly under
env is **backwards compatibility** available only in the single-site shape (no `sites`); in an
environment that declares `sites` they go on each site entry (validateSites rejects a mix at synth
time).

Precedence: the CLI `-c` flag > the env entry in `environments.ts` > the scale defaults
(`config.ts`) > built-in defaults.
However, `-c` only affects fields on the environment entry; `-c` for a site-scoped field is
ignored in a multi-site environment (preventing the accident of one `-c domainName=…` applying to
every site at once, ADR-041).

```ts
// example of infra/config/environments.ts
export const connectionArn = 'arn:aws:codeconnections:ap-northeast-1:...:connection/...'

export const environments = {
  dev: {
    scale: 'small',
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'develop',
    sites: [{ name: 'main', enableWaf: false }],
  },
  prd: {
    scale: 'large',
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'main',
    sites: [
      {
        name: 'main',
        domainName: 'demo.example.com',
        hostedZoneId: 'Z0123456789',
        hostedZoneName: 'example.com',
        allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
        certificateArn: 'arn:aws:acm:us-east-1:...:certificate/...', // created once for the pipeline (see below)
      },
    ],
  },
} satisfies Record<string, EnvironmentConfig>
```

#### Defaults per scale

| Parameter               | small               | medium                               | large                                                     |
| ----------------------- | ------------------- | ------------------------------------ | --------------------------------------------------------- |
| Web vCPU / Memory       | 0.25 / 512 MB       | 0.5 / 1 GB                           | 1 / 2 GB                                                  |
| Web min / max instances | 1 / 2               | 1 / 5                                | 2 / 10                                                    |
| Worker vCPU / Memory    | 0.25 / 1 GB         | 0.5 / 1 GB                           | 1 / 2 GB                                                  |
| Worker min / max tasks  | 1 / 2               | 1 / 2                                | 2 / 5                                                     |
| DB                      | RDS db.t4g.micro    | Aurora 0.5-2 ACU                     | Aurora 2-8 ACU, multi-AZ                                  |
| OpenSearch              | t3.small × 1, 10 GB | m6g.large × 1, 50 GB                 | m6g.xlarge × 2, 100 GB, multi-AZ                          |
| DB pool (web / worker)  | 5 / 3               | 10 / 5                               | 20 / 10                                                   |
| Backups (ADR-037)       | DB retained 7 days  | + S3 versioning, DB retained 14 days | DB retained 35 days + AWS Backup (daily 35d, monthly 12m) |

#### overrides (adjusting individual preset values)

Pick the broad shape with `scale`, then fine-tune individual parameters on the env entry
(ADR-031).

```ts
prd: {
  scale: 'large',
  overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
}
```

#### Usage examples (standalone deploy)

```bash
# deploy the dev environment (the stacks nest under a Stage, so glob the Stage.
# --all only targets the top level and cannot pick up stacks inside a Stage)
npx cdk deploy -c env=dev 'Dev/**'

# deploy the prd environment
npx cdk deploy -c env=prd 'Prd/**'

# temporarily override the scale (takes precedence over the env entry)
npx cdk deploy -c env=dev -c scale=medium 'Dev/**'
```

## Multi-Site Configuration (ADR-041)

Declaring `sites: []` on an environment entry splits it into a SharedStack (the shared box) plus
N SiteStacks (per-site resources). It is **opt-in only**: an environment without `sites` keeps
synthesizing the traditional all-in-one KukanStack with unchanged logical IDs (verified
mechanically by synth snapshot tests in `infra/lib/__tests__/`).

**New environments are recommended to start with a single site** (e.g. `sites: [{ name: 'main' }]`).
Adding `sites` to an already-deployed environment replaces every resource (see the blue-green
migration below), so if there is any chance of adding sites later, adopt the multi-site shape from
the start.

```
Dev (Stage)
├─ KukanSharedStack        VPC/SG, Aurora/RDS, OpenSearch, the ECS cluster,
│                          the Secrets Manager VPC endpoint, SSM parameters
└─ KukanSiteStack<Site>×N  the site DB + role (custom resource), S3, SQS,
                           the web/worker services, CloudFront (+ domain), secrets
```

### Configuration

```ts
prd: {
  account: '...',
  scale: 'medium',
  githubRepo: '...', deployBranch: 'main',
  sites: [
    {
      name: 'citya',            // ^[a-z][a-z0-9]{1,15}$ (used in resource names kukan-<env>-<site>-* and the DB name kukan_<site>)
      domainName: 'catalog.city-a.example.jp',
      hostedZoneId: 'Z...', hostedZoneName: 'city-a.example.jp',
      certificateArn: 'arn:aws:acm:us-east-1:...',   // required in pipeline mode (standalone creates it automatically, see below)
      webAclArn: 'arn:aws:wafv2:us-east-1:...',      // can be shared across sites (same)
    },
    { name: 'cityb', enableWaf: false },
  ],
},
```

- **Certificates / WAF**: the same rules as single-site. In standalone mode GlobalStack creates
  whatever is missing (a per-site ACM certificate — which needs `hostedZoneId` /
  `hostedZoneName` — and one WebACL shared by the sites that have WAF enabled without an ARN).
  Pipeline mode cannot use cross-region references (ADR-030), so paste an ARN per site (create
  them once with `npx cdk deploy -c env=<name> <Stage>/KukanGlobalStack` and set the output ARNs).
  Auto-created certificates and WebACLs are **RETAIN** — even if they disappear from the template
  when you switch to an external ARN, deletion is not attempted (GlobalStack is updated before
  CloudFront, so deleting a resource still in use would fail the deploy). A detached WebACL keeps
  incurring charges, so delete it manually once nothing references it
- **Site-scoped fields cannot be written at the env level**: domainName / hostedZone\* /
  certificateArn / webAclArn / enableWaf / allowedIpRanges / basicAuth / bucketName /
  enableGa4DataApi are declared only inside `sites` (writing them at the env level is rejected by
  validateSites at synth time — safer than being silently ignored). The one exception is
  `overrides`, where the site's values are deep-merged on top of the env's (tuning shared by all
  sites plus per-site overrides). To apply the same gate to every site, define it as a TypeScript
  variable and spread it into each site
- **AWS Backup**: works as-is with multi-site (enabled by default at scale `large`). The DB plan
  lives in the SharedStack (vault `kukan-<env>-backup`, snapshotting the shared cluster once) while
  the bucket plans live in each SiteStack (vault `kukan-<env>-<site>-backup`). Cluster-level PITR
  cannot "roll back just one site", so complement it with scheduled pg_dump runs for per-site
  restores (the ADR-037 / ADR-041 trade-off)
- **If you would rather write it site-first**: `environments.ts` is plain TypeScript, so define a
  site ledger first and write a helper that transposes it into env entries (the native structure is
  env-outermost because the shared box, the AWS account and the pipeline are all per-env)

### Deployment behavior

- Even on the first run the deployment order is controlled automatically: SharedStack → the first
  site (the canary) → **serial deployment** of the remaining sites (during a rolling update ECS
  runs old and new tasks side by side, so keeping the number of simultaneously updating sites at
  one preserves the assumptions of the connection budget). The SSM parameters the SharedStack
  writes (`/kukan/<env>/shared/*`: vpc/sg/ecs/db/search) are resolved by the SiteStacks at deploy
  time (CFN Exports are not used — changes on the shared side are not locked by site references)
- The site DB (`kukan_<site>` plus a dedicated role) is created idempotently by a Lambda custom
  resource inside the SiteStack. Migrations still run against each site's own DB when its tasks
  start
- A change to the main code rolls out to every site in sequence. A brand-only change (ADR-042)
  touches only the affected site (thanks to content-hash management of the image)

### Resources left behind when a site is deleted

When a SiteStack is deleted (`cdk destroy` / removed from sites):

| Resource                                | Behavior                               | Manual purge                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site DB + role                          | **remains** (the CR does not delete)   | On master: `DROP DATABASE kukan_<site>; DROP ROLE kukan_<site>;`                                                                                                                                      |
| S3 bucket                               | **remains** (RETAIN)                   | Empty it, then delete                                                                                                                                                                                 |
| Backup vault (when awsBackup is on)     | **remains** (RETAIN)                   | Delete `kukan-<env>-<site>-backup` after the recovery points expire (or are deleted manually). **Delete it first if re-adding a site with the same name** (fixed names collide, same rule as ADR-037) |
| OpenSearch index                        | **remains** (inside the shared domain) | `DELETE /kukan-<env>-<site>-search`                                                                                                                                                                   |
| SQS queues / secrets / ECS / CloudFront | deleted                                | Check the DLQ contents before deletion                                                                                                                                                                |

### Migrating an existing single-site environment (blue-green)

Do not add `sites` to an already-deployed environment (splitting the stacks and changing physical
names replaces every resource). To migrate, build a new environment in parallel and go through
pg_dump / restore → S3 sync → reindex → DNS switch → destroy the old environment.

### Operational notes

- DB connections are (number of sites) × (`WEB_DB_POOL_MAX` × the **maximum** task count + the
  worker pool)
  - Estimate it against **one site mid-rolling-update** (old and new tasks running together).
    Aurora Serverless v2 fixes max_connections at maxACU (it does not shrink when you scale down).
    At synth time validateSites compares this worst case against an approximate max_connections
    derived from the official AWS table, and **warns above 70% and errors when exceeded**
    (remedies: tighten `sites[].overrides.dbPool` / `web.maxSize`, raise `db.maxAcu`, or use
    RDS Proxy)
- **Do not raise `db.maxAcu` and add a site in the same deployment.** max_connections is a static
  parameter and **stays at the old value until the instance restarts**, even after maxACU changes.
  Deploy the ACU change first, let the restart happen, and add the site once the new ceiling is in
  effect
- A shared OpenSearch domain of medium (m6g.large.search) or above is recommended (a reindex of
  one site ripples into the search latency of every site). It is not enforced, but putting two or
  more sites on a burstable instance (t3.\*) produces a warning at synth time
- For non-AWS environments (Docker Compose), use the opt-in templates in `docker/multi-site/`
  (the procedure is in the README in that directory)

## Security

### IP restriction (CloudFront Function)

When `allowedIpRanges` is set, a CloudFront Function (viewer request) restricts IP addresses
(ADR-027). Both IPv4 CIDRs and IPv6 prefixes are supported. No extra cost.

- ALB: internal (reachable only via the CloudFront VPC Origin, restricted by a managed prefix list)
- Web task SG: allows only port 3000 from the ALB (no direct access)
- Worker task SG: no inbound

### WAF (optional)

WAF is controlled automatically by whether `allowedIpRanges` is set (ADR-027).
Because IP restriction is done by the CloudFront Function, WAF is only enabled when managed rules
(SQLi/XSS protection etc.) are needed.
WAF is deployed at CLOUDFRONT scope in us-east-1 (KukanGlobalStack).

> [!NOTE]
> Pipeline mode cannot create us-east-1 resources (WAF / ACM certificates) because CDK Pipelines
> is incompatible with cross-region references (ADR-030). An env that uses WAF must be created
> once in standalone mode, then set `webAclArn` in `environments.ts`. If WAF is not needed, use
> `enableWaf: false`. See the CI/CD section below for details.

| `allowedIpRanges` | `enableWaf` given | WAF behavior                                      |
| ----------------- | ----------------- | ------------------------------------------------- |
| absent            | absent            | **automatically enabled** (secure by default)     |
| absent            | `true`            | enabled                                           |
| absent            | `false`           | disabled (explicit opt-out)                       |
| present           | absent            | **automatically disabled** (already SG-protected) |
| present           | `true`            | enabled (SG + WAF, defense in depth)              |
| present           | `false`           | disabled                                          |

The three managed rule groups:

| Rule group                            | Content                                                     | Cost     |
| ------------------------------------- | ----------------------------------------------------------- | -------- |
| AWSManagedRulesCommonRuleSet          | SQLi, XSS, SSRF, path traversal etc.                        | $1/month |
| AWSManagedRulesKnownBadInputsRuleSet  | Known-vulnerability attacks such as Log4Shell, Spring4Shell | $1/month |
| AWSManagedRulesAmazonIpReputationList | Blocks malicious IPs using AWS threat intelligence          | $1/month |

Total WAF cost: WebACL $5/month + rules $3/month + requests $0.60/million = **~$9/month**

## Dockerfile

A single multi-target Dockerfile at the project root:

```bash
docker build --target web -t kukan-web .
docker build --target worker -t kukan-worker .
```

## DB Migrations

Migrations run automatically when the Worker starts:

1. The Worker process starts → calls `runMigrations()` (before SQS polling begins)
2. Drizzle's advisory lock makes it safe even when several tasks run at once
3. SQS polling and the health check server start once migrations complete

## Deployment Procedure

There are two deployment modes. Building the Docker image and pushing it to ECR is done
automatically by CDK's `DockerImageAsset`, so no manual `docker build` / `docker push` is needed.

> [!NOTE]
> **ECR tag conflicts when running multiple environments (dev/prd) in one account**
> A `DockerImageAsset` tag is derived from **a hash of the build content**, so the same commit
> produces the same tag for dev and prd. If both environments run in the **same account and
> region** (omitting `account` in `environments.ts`) they share the CDK bootstrap asset ECR
> repository (`cdk-hnb659fds-container-assets-<account>-<region>` by default), so **deploying the
> same commit to dev and prd at nearly the same time** (e.g. merging to prd right after dev) can
> make two pushes to the same tag collide. Current CDK bootstrap creates that repository with
> **`ImageTagMutability: IMMUTABLE`**, so the second push fails on the immutability violation.
>
> It is **transient and retry-safe**, though: `cdk-assets` checks whether the tag exists before
> pushing and skips when the same digest is already there, so **re-running the failed side
> resolves it** (no data is lost).
>
> Permanent fixes (either one):
>
> - **Running prd in a separate account is recommended** (isolation, blast radius, billing, IAM
>   boundaries; ADR-031). With separate accounts the repositories are distinct and this conflict
>   cannot occur.
> - To stay same-account, make the asset ECR repository **MUTABLE**. Rewriting the bootstrap
>   template and re-bootstrapping is the IaC-clean and reliable route (since the tags are hashes,
>   an overwrite is a re-push of identical bytes — effectively a no-op — and safe; immutability is
>   already achieved by the hash tags):
>
>   ```bash
>   cd infra
>   npx cdk bootstrap --show-template \
>     | sed 's/ImageTagMutability: IMMUTABLE/ImageTagMutability: MUTABLE/' \
>     > bootstrap-mutable.yaml
>   npx cdk bootstrap --template bootstrap-mutable.yaml aws://<account>/<region>
>   ```
>
> - If an organizational SCP forbids MUTABLE, **serialize** the dev/prd deployments of the same
>   commit.

| Mode              | Command                                    | Purpose                                             |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| **A. Standalone** | `npx cdk deploy -c env=<name> '<Name>/**'` | Initial setup, manual deployment from a workstation |
| **B. Pipeline**   | push (CDK Pipelines runs automatically)    | Continuous deployment (ADR-030)                     |

Stack names are prefixed with the env (e.g. `Dev/KukanStack` → the CloudFormation stack name
`Dev-KukanStack`).

> [!IMPORTANT]
> **The two modes target the same CloudFormation stack names but synthesize along different
> paths.** Standalone puts the Stage directly under the App (`Dev/KukanStack/...`) while pipeline
> puts it under `KukanPipeline` (`KukanPipeline/Dev/KukanStack/...`), so **the physical resource
> names generated from the path change**. Logical IDs are relative to the stack and therefore
> match, but resources whose physical name is replacement-required (e.g. an Application Auto
> Scaling ScalingPolicy) are **replaced**, and because the ECS service name is fixed the old and
> new policies end up on the same metric, failing with
> `Only one TargetTrackingScaling policy ...` (400). Therefore:
>
> - **To operate a pipeline-managed environment by hand, use the pipeline-qualified path and do
>   not pass `-c env`** (`npx cdk deploy 'KukanPipeline/Dev/KukanStack'`). Do not hit it with the
>   `-c env` standalone synthesis
> - **The pipeline is the source of truth** (it deploys what is committed in git). Standalone
>   deploys your local working tree, so uncommitted changes get rolled back to the git state by the
>   pipeline on the next push
> - Hitting the same stack manually while the pipeline is running is rejected by CloudFormation
>   with `UPDATE_IN_PROGRESS` (**do not run them concurrently**)
> - If your local `cdk.context.json` differs from the committed one, the synth result changes and
>   resources churn back and forth. Use the committed context locally too
>
> Limit `-c env` standalone use to **environments that do not use the pipeline / the initial
> bootstrap / creating the us-east-1 cert and WAF**. Emergency hotfixes to pipeline-managed
> environments go through the pipeline-qualified path above.

### A. Standalone deployment (manual, per environment)

```bash
# 1. Log in to AWS
aws sso login

# 2. Prepare the environment definitions (first time only)
cp infra/config/environments.example.ts infra/config/environments.ts
# edit environments.ts (scale, domain, allowedIpRanges etc.)

# 3. CDK bootstrap (once per account/region)
#    An env using a custom domain/WAF needs us-east-1 bootstrapped too, since GlobalStack lives there
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1

# 4. Deploy (specify the env. Docker build + ECR push + creation of every resource)
#    The stacks nest under a Stage, so glob the Stage (--all cannot pick up stacks inside a Stage)
npx cdk deploy -c env=dev 'Dev/**'

# 5. Register the first user (first time only)
#    Open the sign-up page in a browser and register. While there are no users at all,
#    self-registration is enabled and the first registrant automatically becomes a sysadmin (ADR-038).
#    To create one headlessly there is also a CLI (DB connection details come from env vars):
#      pnpm db:create-user --email admin@example.com --name admin --password <password> --role sysadmin

# 6. Verify
# - Access via the CloudFront domain (or your custom domain)
# - Create a dataset → upload a file → pipeline completes → confirm search works
```

For an env that uses a custom domain/WAF, the us-east-1 global stack (ACM certificate / WAF) is
created at the same time (standalone supports cross-region references).

## CI/CD Automated Deployment (CDK Pipelines + CodeConnections)

### B. Pipeline deployment

A push to `deployBranch` triggers CDK Pipelines (AWS CodePipeline + CodeBuild) to deploy
automatically (ADR-030). It is started from CodeConnections (a GitHub App) as the source, the
pipeline self-mutates (updating itself when its definition changes), and each environment is
deployed as a CDK Stage (ADR-031).

- Pipeline definition: `infra/lib/pipeline-stack.ts` (one pipeline per env)
- Environment boundary: `infra/lib/kukan-stage.ts` (`KukanStage` wraps Global+Main)
- Environment definitions: `infra/config/environments.ts`
- Authentication: CodeConnections (no long-lived tokens)

### Creating the CodeConnections connection (console work)

Authorizing the GitHub App requires browser interaction, so create it from the AWS console
(creating it via CLI/CDK leaves it in `PENDING` and still requires browser authorization).
One connection per account is enough; it can be reused across pipelines.

1. Open **CodeBuild** in the AWS console → **Settings → Connections** at the bottom of the left
   menu
   ("Settings → Connections" is shared across the Developer Tools family — CodeBuild, CodePipeline
   and so on. The Developer Tools home is hard to find, so going through CodeBuild is clearer)
2. Click **Create connection**
3. Choose **GitHub** as the provider → enter a connection name (e.g. `kukan-github`; this is an
   AWS-side label and is not shown on GitHub) → **Connect to GitHub**
4. Click **Install a new app** → install and authorize **AWS Connector for GitHub** on GitHub.
   At this point **choose "Only select repositories" and narrow it to the repositories you deploy**
   (`All repositories` grants too much; principle of least privilege)
5. Back in AWS click **Connect** → the connection status becomes **Available**
6. On the connection detail page, **copy the ARN**
   (`arn:aws:codeconnections:<region>:<account>:connection/...`)
7. Set that ARN as the **top-level `connectionArn`** in `infra/config/environments.ts` (a single
   export shared by every env, not inside an env entry)

> [!NOTE]
> The old name was "AWS CodeStar Connections". Both names may appear in the console and the
> documentation (they are the same feature).

#### Reusing a connection (its scope)

A connection is **a resource of the account (and region), not of the IAM user who created it**,
and the GitHub App authorization is per connection (not per IAM user). Reuse works as follows.

| Scope                                                 | Reusable | Notes                                                                                                 |
| ----------------------------------------------------- | :------: | ----------------------------------------------------------------------------------------------------- |
| A different IAM user/role in the same account         |    ✅    | Anyone with `codeconnections:UseConnection` can use it                                                |
| Multiple pipelines in the same account (dev/prd etc.) |    ✅    | Reuse the same `connectionArn`                                                                        |
| A different AWS account                               |    ❌    | Connections are account-exclusive; resource sharing (RAM) is not supported, so create one per account |

Important: the connection is used by **the pipeline (the source action)**, so it only needs to
exist in **the account where the pipeline runs**. Even if the deployment target (a Stage) is in
another account, deployment there happens through cross-account roles, so the target account does
not need a connection. In this setup (`KukanPipelineStack` in one account, one pipeline per env),
creating **one connection** and sharing `connectionArn` across every env is enough (you only need
one per account if you split the pipelines themselves across accounts).

### Setup procedure (manual, first time only)

```bash
# 1. Prepare the environment definitions (first time only)
cp infra/config/environments.example.ts infra/config/environments.ts
#    edit environments.ts (githubRepo / deployBranch / scale / domain etc. per env;
#    set connectionArn to the value obtained in step 2)

# 2. Create the CodeConnections connection (see "console work" above)
#    → set the connection ARN as connectionArn in environments.ts
#    * approving the GitHub App is a one-off manual step in the console/browser (cannot be IaC-ed)

# 3. Bootstrap (a prerequisite for cdk deploy; once per account and region)
#    GlobalStack lives in us-east-1, so that region is required too. Bootstrap it alongside ap-northeast-1
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1
#    For cross-account setups, bootstrap the target account trusting the pipeline account

# 4. For an env using a custom domain/WAF, create the us-east-1 cert/WAF once in standalone mode
npx cdk deploy -c env=prd Prd/KukanGlobalStack
#    Set the emitted ACM certificate ARN / WAF WebACL ARN as
#    certificateArn / webAclArn in environments.ts
#    (CDK Pipelines is incompatible with cross-region references, so the ARNs are passed as strings)

# 5. Commit environments.ts and cdk.context.json (the fork commits them; CodeBuild's synth reads them)
#    Run cdk synth to resolve the context lookups (AZs, the CloudFront prefix list) into cdk.context.json
npx cdk synth >/dev/null
git add infra/config/environments.ts infra/cdk.context.json && git commit -m "chore: env config"

# 6. Deploy the pipeline stack manually the first time
npx cdk deploy KukanPipeline

# 7. From then on, pushing to the target branch deploys automatically
#    (changes to the pipeline definition are applied by self-mutation)
```

Approval gates (e.g. prd requiring a `ManualApprovalStep` while dev is automatic) are configured in
the pipeline definition.

> [!IMPORTANT]
> **CDK Pipelines is incompatible with cross-region references.** For an env using a custom
> domain/WAF (us-east-1), create the cert/WAF once in step 4 and set `certificateArn` /
> `webAclArn`. If you include an env that needs us-east-1 resources in the pipeline without setting
> them, synth stops with an explicit error telling you to create `KukanGlobalStack` in standalone
> mode and set the ARNs. If WAF is not needed, use `enableWaf: false`.

> [!NOTE]
> **Files synth needs** (because CodeBuild synthesizes from the git source). Neither is gitignored,
> and upstream does not commit them (the fork does):
>
> - **`environments.ts` (the env definitions) is required for pipeline synth.** The fork must
>   commit it (upstream ships only `environments.example.ts`). It carries connection ARNs and
>   account IDs, but those are not secrets (`BETTER_AUTH_SECRET` and the like are CDK-generated
>   secrets).
> - **`cdk.context.json` (the lookup cache for AZs and the CloudFront prefix list,
>   `PrefixList.fromLookup`) — the fork is recommended to commit it for reproducibility.**
>   Without it, values are resolved live through the synth role's lookup role
>   (`cdk-*-lookup-role-*`, `sts:AssumeRole`), which makes synth that much less deterministic.
>
> A fork that wants to keep these private can gitignore them and supply them separately.

> [!IMPORTANT]
> Approving the CodeConnections GitHub App is a one-off manual console step and cannot be fully
> expressed as IaC (only the connection ARN is referenced from code).

## Related Files

- CDK: the whole `infra/` directory
- Environment definitions: `infra/config/environments.ts` (committed by the fork),
  `infra/config/environments.example.ts`
- CI/CD: `infra/lib/pipeline-stack.ts`, `infra/lib/kukan-stage.ts`
- Dockerfile: `Dockerfile`, `.dockerignore`
- Worker health check: `apps/worker/src/index.ts`
- Web health check: `apps/web/src/app/api/health/route.ts`
- SQS adapter: `packages/adapters/queue/src/sqs.ts`
- ADRs: `docs/adr/en/020-ecs-fargate-alb-migration.md`, `docs/adr/en/030-cdk-pipelines-deploy.md`,
  `docs/adr/en/031-multi-environment-deploy.md`

## On-Premises Docker Compose Deployment

Production deployment for on-premises and closed networks (LGWAN etc.) without AWS.
It shares the same Dockerfile and switches between development and production with Docker Compose
profiles.

### Architecture

```
Client ─→ Caddy (:80/:443) ─→ web (:3000)
                                    │
                         ┌──────────┤
                         ▼          ▼
                     postgres   opensearch
                         ▲          ▲
                         │          │
                      worker ──→ minio / elasticmq
```

### Profile design

| Command                               | Services started                                 |
| ------------------------------------- | ------------------------------------------------ |
| `docker compose up -d`                | Infrastructure only (for development, as before) |
| `docker compose --profile prod up -d` | The full production stack (web + worker + caddy) |

### Configuration files

| File                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `compose.yml`       | The unified Compose file (switched by profiles)                   |
| `docker/Caddyfile`  | Reverse proxy configuration (customize TLS, IP restrictions etc.) |
| `.env.prod`         | Production environment variable overrides (gitignored)            |
| `.env.prod.example` | The production environment variable template                      |

### Environment variables

In production Compose, `.env` (development defaults) and `.env.prod` (production overrides) are
layered with `--env-file`. `.env.prod` contains the Docker-internal endpoints
(`http://minio:9000` etc.), overriding the `localhost` values in `.env`.

Values the user must set:

| Variable             | Required | Description                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`    | Yes      | The public URL (e.g. `https://catalog.example.com`)                                |
| `BETTER_AUTH_SECRET` | Yes      | The auth session secret (32 characters or more)                                    |
| `LOG_LEVEL`          | No       | The pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`, default `info`) |

For every other option see `.env.prod.example`.

### Security considerations

- **TLS termination**: configured in the Caddyfile. Supports Let's Encrypt automatic certificates
  or custom certificates.
- **IP restriction**: configurable with the Caddyfile's `remote_ip` matcher.
- **Exposed ports**: infrastructure services (postgres:5432, minio:9000 etc.) are exposed on the
  host. In production, restrict access with a firewall or change `ports:` to `expose:` in
  compose.yml.
- **Password management**: `.env.prod` is gitignored. Always change the default passwords.
- **DB SSL**: enable SSL connections with `POSTGRES_SSLMODE=require`. AWS (RDS/Aurora PG16+)
  requires SSL, so CDK sets it automatically. On-premises defaults to `disable` because
  postgres:16-alpine does not support SSL.
- **Preventing direct ALB access**: on AWS the CloudFront VPC Origin keeps the ALB internal (no
  public IP). On-premises, Caddy sits in front as the reverse proxy.

### Deployment procedure

```bash
# 1. Configure the environment variables
cp .env.prod.example .env.prod
# edit .env.prod

# 2. Build and start
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build

# 3. Register the first user (first time only)
#    Open the sign-up page in a browser and register. While there are no users at all,
#    self-registration is enabled and the first registrant automatically becomes a sysadmin (ADR-038).
#    To create one headlessly: pnpm db:create-user --email ... --role sysadmin

# 4. Check it works
curl http://localhost/api/health
```

### Related files

- Dockerfile: `Dockerfile` (multi-target, no changes needed)
- Compose: `compose.yml`
- Caddy: `docker/Caddyfile`
- Environment variable template: `.env.prod.example`

## Access Analytics (GA4 Integration)

An access analytics feature for internet-facing environments. GA4 is the measurement platform;
KUKAN itself contains no measurement logic.
In closed networks such as LGWAN it is disabled automatically because
`brandConfig.gaMeasurementId` is unset (the default).

Design decision details: `docs/adr/en/024-ga4-access-analytics.md`

### 4a: Conditionally embedding gtag.js

Controlled by `brandConfig.gaMeasurementId` (`brand-config.ts`). When it is `null` (the default),
gtag.js is not loaded. The fork writes the measurement ID directly (following the ADR-023 policy;
no environment variable is involved).

**What is measured:**

| Item           | Method                              | Extra code                                |
| -------------- | ----------------------------------- | ----------------------------------------- |
| Page views     | GA4 automatic measurement           | None                                      |
| File downloads | Custom event                        | `onClick` on `DownloadButton`             |
| Site search    | Enhanced Measurement auto-detection | None (automatic from the `?q=` parameter) |

**Files to change:**

| File                                          | Change                                      |
| --------------------------------------------- | ------------------------------------------- |
| `apps/web/src/types/brand.ts`                 | Add `gaMeasurementId?: string \| null`      |
| `apps/web/src/brand/brand-config.ts`          | Add `gaMeasurementId: null` as the default  |
| `apps/web/src/app/layout.tsx`                 | Conditionally embed gtag.js with `<Script>` |
| `apps/web/src/components/download-button.tsx` | Send the custom event from `onClick`        |

**The download event:**

```typescript
gtag('event', 'file_download', {
  file_name: displayFilename,
  link_url: href,
  dataset_name: datasetNameOrId,
  resource_id: resourceId,
  format: format,
})
```

### 4b: The analytics dashboard in the admin screens

Fetches data from the GA4 Data API and shows analytics rankings in the admin screens (sysadmin
only).

**Environment variables:**

| Variable           | Purpose                                 | When unset                              |
| ------------------ | --------------------------------------- | --------------------------------------- |
| `GA4_PROPERTY_ID`  | The GA4 property ID                     | The analytics page shows setup guidance |
| `GA4_CLIENT_EMAIL` | The service account's email address     | Same                                    |
| `GA4_PRIVATE_KEY`  | The service account's private key (PEM) | Same                                    |

**The analytics page:**

| Ranking            | Description                                |
| ------------------ | ------------------------------------------ |
| Dataset views      | Page views of `/dataset/{name}`            |
| Resource views     | Page views of `/dataset/.../resource/{id}` |
| Resource downloads | The `file_download` custom event           |
| Search keywords    | Site search from Enhanced Measurement      |

**UI features:**

- Period selection: presets (7 days / 30 days / 90 days / 1 year) + free calendar selection
- Rankings: paginated
- When unset: the menu is still shown, and the page displays GA4 setup instructions

**Data retrieval:**

- Real-time calls to the GA4 Data API + lru-cache (TTL 1 hour)
- Uses the `@google-analytics/data` Node.js client
- Service account authentication

**Files to change:**

| File                                                         | Content                                    |
| ------------------------------------------------------------ | ------------------------------------------ |
| `packages/api/src/services/analytics-service.ts`             | GA4 Data API calls + caching               |
| `packages/api/src/routes/admin.ts`                           | Add the `GET /admin/analytics/*` endpoints |
| `apps/web/src/app/dashboard/admin/analytics/page.tsx`        | The analytics dashboard page               |
| `apps/web/src/components/analytics/analytics-ranking.tsx`    | The ranking display component              |
| `apps/web/src/components/analytics/analytics-date-range.tsx` | The period selection component             |

### Related files (access analytics)

- ADR: `docs/adr/en/024-ga4-access-analytics.md`
- Download button: `apps/web/src/components/download-button.tsx`
- Brand configuration: `apps/web/src/brand/brand-config.ts` (ADR-023)
