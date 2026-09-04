> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/031-multi-environment-deploy.md`](../jp/031-multi-environment-deploy.md).

# ADR-031: Multi-Environment (dev / prd, etc.) Deployment Design (CDK Stage)

## Status

**Accepted** — Implemented and in operation (`infra/lib/kukan-stage.ts` / `config/environments.ts`). Designed together with ADR-030 (CDK Pipelines). ADR-041 extends it with the site axis.

## Context

The current CDK assumes a single environment.

- Stacks are instantiated directly in `bin/app.ts` with no concept of environments (`infra/bin/app.ts`)
- `loadConfig` is flat (`infra/lib/config.ts`)
- The S3 bucket name has a fixed default `kukan-resources`, and there are many other fixed physical names (cluster `kukan`, SQS `kukan-pipeline`, ECS `kukan-web`/`kukan-worker`, CF Function `kukan-viewer-request`, etc.)

Since KUKAN is meant to be forked as OSS, it is desirable for forks to **build multiple environments (e.g. dev / prd) by editing a single config file**, and to choose between **same-account and separate-account** operation. Since deployment uses CDK Pipelines (ADR-030), we adopt **CDK Stage** — its unit of API — as the environment boundary.

### Namespace premise (important)

- **S3 bucket names are globally unique across all of AWS.** Even with separate accounts, identical names collide.
- IAM role names, ECS/OpenSearch/SQS/RDS names, log groups, etc. are **account-scoped**.
- **CDK Stage namespaces stack names and logical IDs by the Stage name** (e.g. `Dev-KukanStack`). This makes **auto-named resources** unique per stage, but **resources given explicit physical names are not auto-separated by Stage** (they stay literal).

## Decision

**Declare environments in an environment definition file `infra/config/environments.ts`, and instantiate each environment as a `KukanStage` (`cdk.Stage`). CDK Pipelines (ADR-030) deploys these stages via `addStage()`. Both same-account and separate-account operation can be switched solely through this file.**

### KukanStage (environment boundary)

```ts
// infra/lib/kukan-stage.ts
export class KukanStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: EnvironmentConfig & cdk.StageProps) {
    super(scope, id, props)
    const global = new KukanGlobalStack(this, 'KukanGlobalStack', { ... })  // us-east-1
    new KukanStack(this, 'KukanStack', { ...props, globalCertificateArn: global.certificateArn })
  }
}
```

- The Stage encapsulates the two stacks Global (us-east-1) + Main (ap-northeast-1). Stack names are prefixed by the Stage name, e.g. `Dev-KukanStack`
- Set `env: { account, region }` at the Stage level → separate-account operation is natural

### Environment definition file

```ts
// infra/config/environments.ts (edited & committed by the fork; upstream does not commit it)
export interface EnvironmentConfig {
  account: string // required: target account ID (misdeployment guard — CDK rejects a mismatch)
  region?: string // omit → ap-northeast-1
  scale?: Scale
  dbEngine?: DbEngine
  enableOpenSearch?: boolean
  enableWaf?: boolean
  allowedIpRanges?: string[]
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  certificateArn?: string // pre-created us-east-1 ACM cert ARN (for pipeline mode, ADR-030)
  webAclArn?: string // pre-created us-east-1 WAF WebACL ARN (for pipeline mode, ADR-030)
  bucketName?: string // omit → auto-naming (globally unique)
  enableGa4DataApi?: boolean
  githubRepo?: string // CodeConnections source repository
  deployBranch?: string // branch that deploys this environment
  overrides?: DeepPartial<ScaleComputed> // override individual preset parameters (see below)
}

/** Intended account for the pipelines; the credentials decide, this only validates (optional) */
export const pipelineAccount = '000000000000'

export const environments = {
  dev: { account: '000000000000', scale: 'small', deployBranch: 'develop' },
  prd: {
    account: '000000000000',
    scale: 'large',
    deployBranch: 'main',
    domainName: 'catalog.example.com',
  },
} satisfies Record<string, EnvironmentConfig>
```

- Commit `infra/config/environments.example.ts`; forks copy it to `environments.ts`, edit, and commit it (upstream does not commit a real `environments.ts`).

### Supporting both same-account and separate-account

| Mode             | `account` setting       | Collision avoidance                                                                                                                       |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Separate account | a distinct ID per env   | Separated by account; set via the Stage `env`                                                                                             |
| Same account     | the same ID in each env | Stage name separates stack names, logical IDs, and auto-named resources. **Explicit physical names still need env suffixing** (see below) |

The account holding the pipeline itself is chosen independently of the target accounts.
CDK Pipelines deploys by assuming the bootstrap roles of each Stage's account, so
**keeping only the pipelines in a dedicated CI/CD account and dealing dev / prd out to
separate accounts** works with no code change (the steps — bootstrapping the targets with
trust, where the connection lives, which account creates the us-east-1 cert / WAF — are in
`docs/specs/en/phase4-deploy.md`). A CodeConnections connection is private to an account
(and region), so one created in the pipeline account is shared by every env.

CMK-encrypting the artifact bucket (`crossAccountKeys`) is derived from "pipeline account
!= Stage account", not exposed as a setting.

`pipelineAccount` in `environments.ts` (optional) is the misdeployment guard for that
separation. Unlike an env's `account`, where the pipeline lands is otherwise decided
silently by the active credentials (running `cdk deploy KukanPipeline` from a prd session
grows a second pipeline in prd). Declared, synth fails immediately when the credentials
are for another account.

> [!NOTE]
> **Separate accounts are RECOMMENDED for prd** (isolation, blast radius, billing,
> IAM boundary). Same-account operation is also a first-class supported path (so as
> not to raise the barrier for OSS self-hosters), with one caveat: deploying the
> same commit to multiple envs near-simultaneously can race on pushing the same tag
> to the CDK bootstrap asset ECR repository (current bootstrap creates it with
> `ImageTagMutability: IMMUTABLE`). The conflict is **transient and retry-safe**
> (`cdk-assets` skips an existing digest, so re-running resolves it); the durable
> fix is to make that repository MUTABLE. Separate accounts avoid it entirely since
> the repositories are distinct. See `docs/specs/en/phase4-deploy.md` for details and
> the MUTABLE procedure.

### Handling fixed physical names

Even with Stage namespacing, **explicit physical names are not auto-separated**, so for multiple environments in the same account, resolve the following.

- Where possible, **drop the explicit physical name** and let CDK auto-name (with the Stage prefix): cluster name, ECS service name, SQS queue name, CF Function name
- For those kept, suffix by env (e.g. `kukan-pipeline-<env>`)
- **S3 uses auto-naming** because names are globally unique (or `name+account+env`). References go through the construct (`bucket.bucketName` / `grantReadWrite()`) with no literal dependency, so the change is confined to the creation site (`storage.ts`)

### Overriding individual scale-preset parameters

Currently `scale` (small/medium/large) adopts `SCALE_DEFAULTS` wholesale, and only `dbEngine` can be overridden. Extend this so the env definition's **deep-partial `overrides`** is deep-merged onto the preset.

```ts
prd: {
  scale: 'large',
  overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
},
// config.ts: const merged = deepMerge(SCALE_DEFAULTS[scale], envEntry.overrides ?? {})
```

- Fine-grained overrides are primarily done in the env file. Add synth-time consistency checks (e.g. `indexReplicas < instanceCount`, Aurora `minAcu <= maxAcu`)

### Value precedence

env entry (`scale` + `overrides`) > scale defaults (`config.ts`) > built-in defaults. Ad-hoc experiments use context overrides via `cdk synth -c ...`.

### Connection to CI (CDK Pipelines) and supplying env definitions

- CDK Pipelines (ADR-030) reads `environments.ts` and does `pipeline.addStage(new KukanStage(...))` per env, setting gates such as automatic for dev and a `ManualApprovalStep` for prd
- **Important**: the pipeline's Synth runs **`cdk synth` in CodeBuild from the git source**. The two files play different roles:
  - **`environments.ts` (env definitions) — required for pipeline synth**. Without it in the CodeBuild checkout the correct env cannot be built, so **forks must commit it**. Upstream commits only `environments.example.ts` (a fresh clone falls back to the example)
  - **`cdk.context.json` (AZ / CloudFront prefix-list lookup cache) — recommended (forks commit) for determinism**. If absent, it resolves live via the lookup role (`cdk-*-lookup-role-*`, `sts:AssumeRole`) granted to the synth role — at the cost of being non-deterministic
- Neither is gitignored; upstream commits neither
- `environments.ts` holds a connection ARN and account ID, but **no real secrets** (`BETTER_AUTH_SECRET` etc. are CDK-generated Secrets; a connection ARN is useless without IAM permissions). The account ID is also in `cdk.context.json`
- A fork that wants secrecy can gitignore these and supply them separately (e.g. via SSM) as an exception

## Trade-offs

- **Connection ARN / account ID land in the fork's repo**: not secrets, but exposed in a public fork. If that matters, gitignore them and supply separately
- **Same account shares blast radius**: choose separate accounts if strict isolation is required
- **Inventory of explicit physical names**: same-account multi-env requires removing/suffixing fixed names
- **Standalone and pipeline target the same stack**: both modes share `KukanStage`, so the CFN stack name (`<Env>-KukanStack`) matches and there is no collision. But **the pipeline is the source of truth** (it deploys committed git state), so a local standalone change is reverted on the next push. Limit standalone to bootstrap / cert-WAF creation / emergencies, and commit/push permanent changes so the pipeline stays in sync (concurrent runs are rejected by CloudFormation with `UPDATE_IN_PROGRESS`)

## Consequences (changes at implementation time)

- New: `infra/config/environments.ts` (committed by forks) + `environments.example.ts` (committed by upstream) + type `EnvironmentConfig`
- New: `infra/lib/kukan-stage.ts` (`KukanStage`, encapsulating Global+Main)
- `infra/bin/app.ts`: read `environments.ts` and register stages with CDK Pipelines (ADR-030) (optionally also a standalone Stage for local direct deploys)
- `infra/lib/config.ts`: `loadConfig` merges the env entry + `overrides`; change the `bucketName` default to auto-naming
- `infra/lib/constructs/*`: remove/suffix fixed physical names (cluster / service / queue / cf-function / bucket)
- `.gitignore`: do **not** ignore `infra/config/environments.ts` or `cdk.context.json` (forks commit them)
- Docs: add env-switching steps to `docs/specs/en/phase4-deploy.md` / `README.md`

## Related

- ADR-041 (Multi-site deployment): extends this ADR by adding a site axis inside the environment axis
- ADR-030 (Automated deployment via CDK Pipelines): `docs/adr/en/030-cdk-pipelines-deploy.md`
- ADR-020 (ECS Fargate + ALB): `docs/adr/en/020-ecs-fargate-alb-migration.md`
- ADR-027 (CloudFront reintroduction / 2-stack setup): `docs/adr/en/027-cloudfront-reintroduction.md`
- Deployment spec: `docs/specs/en/phase4-deploy.md`
