> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/074-pipeline-stack-per-environment.md`](../jp/074-pipeline-stack-per-environment.md).

# ADR-074: One Pipeline Stack per Environment

## Status

**Accepted** — Implemented (`infra/bin/app.ts`, `infra/lib/stacks/pipeline-stack.ts`).
Supersedes the part of ADR-030's "Pipeline structure" that places a single `KukanPipelineStack`,
together with its setup step 3, and the part of ADR-031 about `pipelineAccount` and sharing the
connection.

## Context

Until now `infra/bin/app.ts` created only one pipeline stack (`KukanPipeline`) and, inside it, a
CodePipeline per environment (`kukan-<env>`). Each pipeline, through self-mutation, updates **the
whole `KukanPipeline` stack from its own branch's code**.

When environments have different `deployBranch`es and the branches drift apart (for example,
promoting develop → demo → main), the following happens.

1. Every time the prd pipeline runs, the other environments' pipeline definitions are reverted to
   main's older code, and the next run of that environment's pipeline restores the newer
   definition. This repeats
2. A pipeline for an environment added to `environments.ts` on the demo branch is removed if the
   prd pipeline runs before the change reaches main
3. A push to one environment's branch rewrites the other environments' pipeline definitions too
   (roles and build specs). Anyone who can push to develop can change the prd pipeline
4. Because there is one stack, the account that holds the pipelines cannot differ per environment
   (`pipelineAccount` and `connectionArn` are shared by all environments). Even with the
   separate-account setup ADR-031 recommends, the dev pipeline cannot live in the dev account and
   the prd pipeline in the prd account

### App stack paths are baked into the templates

The app stacks under a pipeline's Stage (`KukanStack`, `KukanSharedStack`, `KukanSiteStack<Name>`)
have CloudFormation stack names `<Env>-<Stack>`, which do not include the parent stack's ID. Yet
synthesizing with only the parent's ID changed and comparing shows that the template contents
change. CDK builds some names from the construct path from the app root; in practice the following
changed.

- Logical IDs of security group ingress rules (they contain the peer SG's path, as in
  `NetworkWebSgfromKukanPipelineDemoKukanSharedStack…`)
- The `Name` tags of the VPC and subnets
- Task definition families and custom resource handlers

When a logical ID changes, CloudFormation creates the new rule before deleting the old one, so two
rules with the same content can overlap and the creation can fail. Pinning the stack name with
`stackName` alone does not prevent this.

## Decision

### 1. One pipeline stack per environment

- The stack ID and CloudFormation stack name are `KukanPipeline-<Env>` (`<Env>` is the
  environment key through `pascal()`, e.g. `KukanPipeline-Dev`). `KukanPipelineStack` receives a
  single environment, and `buildPipelines()` loops over the environments to build them (`bin/app.ts`
  calls it, and so do the tests)
- Self-mutation runs `cdk -a . deploy KukanPipeline-<Env>` and updates only its own stack.
  Synth also bundles only its own Stage's assets
  (`--exclusively KukanPipeline-<Env> 'KukanPipeline/<Env>/**'`)
- One environment's pipeline can be deployed by hand: `npx cdk deploy KukanPipeline-Dev`
- The per-environment checks are unchanged (an environment without `githubRepo` gets no pipeline,
  and is refused if it has `deployNotification`; an environment that needs a us-east-1
  certificate or WAF is refused)
- The cross-region support stack created when an environment's region differs from the pipeline's
  is also held per pipeline (`reuseCrossRegionSupportStacks: false`, named
  `KukanPipeline-<Env>-support-<region>`). By CDK's default, environments in the same region share
  the first pipeline's support stack, and other environments' self-mutation would update it

### 2. Stages stay at the same path

Each environment's Stage is placed not inside the pipeline stack but under a plain Construct
`KukanPipeline` directly under the App. App stacks keep the construct path
`KukanPipeline/<Env>/<Stack>`, and their stack names, artifact IDs and templates do not change
(container image asset hashes are derived from the source, so they change on every commit anyway).
CDK Pipelines accepts a Stage outside the pipeline stack in `addStage()`.

`infra/lib/__tests__/synth-pipeline.test.ts` synthesizes two environments on different branches and
checks that two pipeline stacks are created, that the app stacks' names are the same as before the
change, and that the templates match the shape with the Stages inside one stack.

The qualified paths for manual operations (`npx cdk deploy 'KukanPipeline/Dev/KukanStack'`,
without `-c env`) keep working as before.

### 3. The pipeline's account can be chosen per environment

- An environment entry can set `connectionArn`. Environments that do not set it use the top-level
  value (backward compatible)
- The account a pipeline goes in is decided by the account of the connection it uses. A
  CodeConnections connection belongs to an account, and a pipeline can only read its own account's
  connections, so it would not work in another account. A connection ARN cannot be built from an
  account (the trailing ID is assigned at creation), so what you write is the connection's ARN, not
  the account
- The top-level `pipelineAccount` has served its purpose. The old guard "stop if the credentials'
  account differs" is taken over by comparing the account derived from the connection with the
  credentials. It is still accepted for forks that have it, and synth refuses it if it differs from
  the top-level connection's account. There is no per-environment `pipelineAccount` (it would only
  repeat what the connection ARN says)
- Synth builds only the pipelines in the credentials' account and warns about the ones it skipped.
  A pipeline's self-mutation synthesizes in that pipeline's account, so it builds only that
  account's pipelines. If the credentials would build no pipeline at all, synth stops (the guard)
- Until now, without `pipelineAccount` any credentials could build every environment's pipeline. In
  a working fork the connection is always in the pipeline's account, so the behavior with the right
  credentials does not change
- Splitting the stacks prevents only unintended overwrites of other environments' pipelines. The
  command self-mutation runs is built from that branch's code, and pipelines in the same account use
  the same bootstrap deploy role. As long as they are in the same account, someone who can push to
  develop deliberately rewriting prd's pipeline stack cannot be prevented. To cut that off, put
  prd's pipeline in an account that dev's pipeline does not share (per-environment `connectionArn`)

## Migration (forks already deployed)

The pipeline name `kukan-<env>` and the self-mutation CodeBuild project name
`kukan-<env>-selfupdate` are fixed physical names and cannot exist in the old `KukanPipeline` stack
and the new stacks at the same time. Delete the old stack first, then deploy the per-environment
stacks.

Pushing to an environment's branch that has this version's code makes the old pipeline fail at
synth or self-mutation (the `KukanPipeline` stack no longer exists), before it reaches deployment.
That environment is not deployed automatically until the migration is done.

1. With the pipeline account's credentials, delete the old stack. The new code has no
   `KukanPipeline` stack, so `cdk destroy` cannot select it:
   `aws cloudformation delete-stack --stack-name KukanPipeline`.
   If an environment is in a region different from the pipeline's, delete the support stack
   `KukanPipeline-support-<region>` the same way. The app stacks (`<Env>-KukanStack` etc.) are
   separate CloudFormation stacks and remain
2. For each environment, check out its branch containing this version and run
   `cd infra && npx cdk deploy KukanPipeline-<Env>`. The new pipeline runs once on the branch head
   right after it is created. The app stacks' names and templates do not change, so nothing is
   replaced other than this version's own changes. Environments whose branch does not have this
   version yet wait until it arrives
3. In environments with `deployNotification`, the secret holding the Slack webhook is deleted with
   the old stack. Paste the URL again into the secret shown in the new stack's outputs
4. Cleanup: the old stack's artifact bucket (and the support stack's replication bucket) and the
   notification Lambda's log group are retained on deletion (DeletionPolicy Retain). Empty them and
   delete them by hand. The KMS key of a pipeline that deploys to other accounts is scheduled for
   deletion by CloudFormation

If you need to deploy urgently during the migration, deploy by hand with the qualified path
(`npx cdk deploy 'KukanPipeline/<Env>/<Stack>'`, without `-c env`).

## Trade-offs

- **Migration effort**: existing forks delete the old stack and deploy each environment by hand
  once, and automatic deployment stops in the meantime. Importing the fixed-name resources into the
  new stacks (CloudFormation resource import) is possible, but CDK Pipelines creates many resources
  and the procedure gets long, so it is not adopted
- **Stages outside the pipeline stack**: this differs from the CDK Pipelines examples. Tests check
  that a pipeline can include its own Stage and that the app stacks do not change
- **`cdk.context.json` is made per pipeline account**: synth builds only the Stages in the
  credentials' account, so once the pipelines are split across accounts, the synth that records the
  lookup results is also run per account
- **The cost per pipeline is unchanged**: the number of pipelines is still the number of
  environments

## Related

- ADR-030 (Automated deployment via CDK Pipelines): `docs/adr/en/030-cdk-pipelines-deploy.md`
- ADR-031 (Multi-environment deployment): `docs/adr/en/031-multi-environment-deploy.md`
- ADR-035 (Release notes): `docs/adr/en/035-semver-release-notes.md`
- Deployment spec: `docs/specs/en/phase4-deploy.md`
