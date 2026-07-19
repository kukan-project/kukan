> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/030-cdk-pipelines-deploy.md`](../jp/030-cdk-pipelines-deploy.md).

# ADR-030: Automated Deployment via CDK Pipelines (CodeConnections)

## Status

**Accepted** — Implemented and in operation (`infra/lib/pipeline-stack.ts`; CodePipeline V2 in PR #102). Designed together with ADR-031 (Stage-based multi-environment).

## Context

We want automated deployment triggered by pushes to `main` etc. There are two ways to achieve this.

| Approach              | Execution location                    | Overview                                                                |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| GitHub Actions + OIDC | GitHub runners (outside AWS)          | Run `cdk deploy` in a workflow; obtain short-lived credentials via OIDC |
| **CDK Pipelines**     | Inside AWS (CodePipeline + CodeBuild) | Define the pipeline in CDK code; push-triggered and self-mutating       |

We initially considered GitHub Actions + OIDC (uncommitted). However, for the following requirements we adopt **CDK Pipelines**.

- We want **staged deployment with approval gates** across multiple environments (dev / prd, and eventually multi-account)
- We want to **centralize the deployment mechanism in AWS / CDK** and benefit from self-mutation (the pipeline updates itself when its definition changes)
- We want to avoid managing an externally-held trust relationship (the OIDC role)

The CDK Pipelines API is designed around CDK Stages, so it meshes naturally with the Stage-based multi-environment design (ADR-031).

## Decision

**Use CDK Pipelines (`aws-cdk-lib/pipelines`) + CodeConnections (GitHub App integration), triggered by branch pushes.**

### Source / trigger

```ts
new CodePipeline(this, 'Pipeline', {
  selfMutation: true,
  synth: new ShellStep('Synth', {
    input: CodePipelineSource.connection('kukan-project/<repo>', '<branch>', {
      connectionArn: '<CodeConnections ARN>',
    }),
    commands: ['corepack enable', 'pnpm install --frozen-lockfile', 'cd infra && npx cdk synth'],
  }),
})
```

- AWS detects a push to the specified branch → starts CodePipeline → Synth (CodeBuild) → deploy stages
- `triggerOnPush` defaults to true. Branch / file-path / tag trigger filters are available with CodePipeline V2 (configure via escape hatch when needed)
- Authentication is via **CodeConnections (AWS Connector GitHub App)**. No long-lived tokens

### Pipeline structure

- Define `CodePipeline` in `KukanPipelineStack`
- Add each environment as a Stage (ADR-031's `KukanStage`) via `addStage()`. Insert `ManualApprovalStep` in `pre`/`post` to set gates such as manual approval for prd and automatic for dev
- Branch strategy: `develop` → dev, `main` → prd. Choose either "a single pipeline with multiple stages (waves + approvals)" or "a pipeline per branch"

### Setup steps (manual, first time only)

1. **Create a CodeConnections connection**: approve the GitHub App (AWS Connector) in the AWS console and obtain the Connection ARN (this approval is a one-time manual step that cannot be expressed as IaC)
2. `cdk bootstrap` (per account / region; for cross-account, bootstrap with a trust relationship)
3. **Deploy the pipeline stack once manually** (`cd infra && npx cdk deploy KukanPipeline`)
4. After that, pushes deploy automatically; changes to the pipeline definition are applied via self-mutation

## Trade-offs

- **Incompatible with cross-region references (important)**: the CloudFront ACM certificate and WAF must live in us-east-1, but CDK Pipelines is incompatible with cross-region references (CDK's `crossRegionReferences`). Cross-region references use a Lambda-backed support stack (`BootstraplessSynthesizer`) that collides with the Docker assets in the main stack, so synth fails. Therefore, in pipeline mode, create the us-east-1 cert/WAF **once via standalone** and pass their ARNs as **strings** in `environments.ts` (`certificateArn` / `webAclArn`, ADR-031). Standalone mode can still auto-create the cert/WAF via cross-region references as before
- **Context lookups must be resolved**: synth runs in CodeBuild, so context lookups (AZs, CloudFront prefix list) must resolve. `cdk.context.json` is not gitignored; **forks commit their values** to make synth deterministic (upstream does not commit it). When absent it resolves live via the lookup-role `sts:AssumeRole` permission granted to the synth role, but that is non-deterministic
- **CodeConnections approval is manual**: the GitHub App authorization is a one-time manual console action and cannot be fully expressed as IaC (only the Connection ARN is referenced in code)
- **Cost**: CodePipeline ~$1/month + CodeBuild build minutes
- **Separation due to being AWS-contained**: if general CI (unit tests, etc.) lives on GitHub, deployment (AWS) and CI (GitHub) are split
- **Cross-account bootstrap is somewhat more complex**
- Compared with the GitHub Actions option: gains self-mutation and native multi-account / approval gates, but loses the generality of GitHub runners

## Consequences (changes at implementation time)

- New: `infra/lib/pipeline-stack.ts` (`CodePipeline` definition), `infra/lib/kukan-stage.ts` (Stage, ADR-031)
- **Removed**: `infra/lib/constructs/ci-oidc.ts`, `.github/workflows/deploy.yml` (withdrawing the GitHub Actions + OIDC option; the `CiOidc` wiring in `kukan-stack.ts` is also removed)
- `infra/bin/app.ts`: instantiate the pipeline stack (optionally also a standalone Stage for local direct deploys)
- Config: add the CodeConnections Connection ARN to the environment config (ADR-031's `environments.ts`) or context
- Docs: update `docs/specs/phase4-deploy.md` / `README.md` / `site` to the CDK Pipelines procedure

## Related

- ADR-031 (Stage-based multi-environment deployment): `docs/adr/en/031-multi-environment-deploy.md`
- ADR-020 (ECS Fargate + ALB): `docs/adr/en/020-ecs-fargate-alb-migration.md`
- ADR-027 (CloudFront reintroduction / 2-stack setup): `docs/adr/en/027-cloudfront-reintroduction.md`
- AWS official: [CDK Pipelines](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html) / [CodeConnections](https://docs.aws.amazon.com/dtconsole/latest/userguide/connections.html)
