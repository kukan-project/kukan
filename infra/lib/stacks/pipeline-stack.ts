/**
 * KUKAN CI/CD Pipeline Stack (ADR-030).
 * CDK Pipelines (AWS CodePipeline) with a CodeConnections (GitHub App) source.
 * One stack per environment, each holding that environment's self-mutating pipeline.
 */

import * as cdk from 'aws-cdk-lib'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines'
import { Construct } from 'constructs'
import {
  DEFAULT_REGION,
  needsGlobalStack,
  pipelinesInAccount,
  resolveCpuArchitecture,
  resolvePipelinePlacement,
  resolveWebCompute,
  resolveEnv,
  type EnvironmentConfig,
} from '../config.js'
import { ARCHITECTURES } from '../cpu-architecture.js'
import { pascal } from '../naming.js'
import { KukanStage, MAIN_STACK_ID, siteStackId } from './kukan-stage.js'
import { DeployNotificationConstruct } from '../constructs/deploy-notification.js'

/** The Node major the synth step runs on; keep it with the Dockerfile's (see docs/node-version.md). */
const NODE_MAJOR = 24

/** CDK Pipelines' name for the synth step's output, the cloud assembly. */
const SYNTH_OUTPUT = 'Synth_Output'
/** The cloud assembly without its assets, what the deploy actions read. */
const TEMPLATES_ONLY = 'Synth_Output_Templates'
/** CDK Pipelines' name for the stage that publishes the assets. */
const ASSETS_STAGE = 'Assets'
/** CodePipeline's limit on the actions in one stage. */
const MAX_ACTIONS_PER_STAGE = 50

/** One row of the notification's site table. */
const entry = (label: string, domainName?: string) => ({
  label,
  ...(domainName && { url: `https://${domainName}` }),
})

/**
 * The construct every environment's Stage is built under, so its app stacks
 * keep the path they were first deployed at, `KukanPipeline/<Env>/...`. The
 * pipelines once lived in one stack of this name, and the path is in more than
 * the stack names: security group rules' logical IDs, the VPC's Name tag and
 * task definition families are derived from it, and a changed path replaces
 * them on a deployed environment.
 */
export const STAGE_SCOPE_ID = 'KukanPipeline'

/** An environment's pipeline stack, e.g. `KukanPipeline-Dev`: its ID and CloudFormation name. */
export const pipelineStackId = (name: string) => `${STAGE_SCOPE_ID}-${pascal(name)}`

/**
 * Whether environment `name` gets a pipeline: only with a source repo (deploy
 * the others standalone). Throws on settings that need one it does not get.
 */
export function hasPipeline(
  name: string,
  config: EnvironmentConfig
): config is PipelineEnvironmentConfig {
  if (config.githubRepo) return true
  if (config.deployNotification) {
    throw new Error(
      `Environment "${name}": deployNotification reports on a pipeline's executions, but ` +
        `this environment has no githubRepo and so gets no pipeline. Set githubRepo to ` +
        `deploy it in pipeline mode, or drop deployNotification. See ADR-030.`
    )
  }
  return false
}

/** An environment definition with a source repo, which a pipeline can be built from. */
export type PipelineEnvironmentConfig = EnvironmentConfig & { githubRepo: string }

export interface KukanPipelineStackProps extends cdk.StackProps {
  /** The environment's key in config/environments.ts, e.g. `dev`. */
  environmentName: string
  /** Its definition. */
  config: PipelineEnvironmentConfig
  /** CodeConnections connection ARN, in the pipeline's account (ADR-030). */
  connectionArn: string
}

/** config/environments.ts, and the account of the credentials synthesizing it. */
export interface BuildPipelinesProps {
  environments: Record<string, EnvironmentConfig>
  connectionArn?: string
  pipelineAccount?: string
  credentialsAccount: string
}

/**
 * Pipeline mode: a pipeline stack for each environment with a source repo
 * whose pipeline is in the credentials' account (ADR-074). The others are
 * returned as skipped, with the account their pipeline is in.
 */
export function buildPipelines(
  app: cdk.App,
  { environments, connectionArn, pipelineAccount, credentialsAccount }: BuildPipelinesProps
): { built: KukanPipelineStack[]; skipped: { name: string; account: string }[] } {
  const pipelines = []
  for (const [name, config] of Object.entries(environments)) {
    if (!hasPipeline(name, config)) continue
    const placement = resolvePipelinePlacement(name, config, { connectionArn, pipelineAccount })
    pipelines.push({ name, config, placement })
  }
  const { here, elsewhere } = pipelinesInAccount(pipelines, credentialsAccount)
  return {
    built: here.map(
      ({ name, config, placement }) =>
        new KukanPipelineStack(app, pipelineStackId(name), {
          env: { account: placement.account, region: DEFAULT_REGION },
          environmentName: name,
          config,
          connectionArn: placement.connectionArn,
        })
    ),
    skipped: elsewhere.map(({ name, placement }) => ({ name, account: placement.account })),
  }
}

/**
 * One environment's self-mutating pipeline, triggered by its branch. Each
 * environment has a stack of its own, so a pipeline's self-mutation updates
 * only its own pipeline, from its own branch.
 */
export class KukanPipelineStack extends cdk.Stack {
  /** On the App itself: the Stage goes beside it, under STAGE_SCOPE_ID. */
  constructor(scope: cdk.App, id: string, props: KukanPipelineStackProps) {
    super(scope, id, props)

    const { environmentName: name, config } = props
    const stageScope =
      scope.node.tryFindChild(STAGE_SCOPE_ID) ?? new Construct(scope, STAGE_SCOPE_ID)
    // CDK Pipelines cannot create the us-east-1 cert/WAF (cross-region is incompatible).
    // Fail early with an actionable message instead of a cryptic synthesizer error.
    if (needsGlobalStack(config)) {
      const where = config.sites?.length
        ? 'per site in config/environments.ts (sites[].certificateArn / webAclArn)'
        : 'in config/environments.ts'
      throw new Error(
        `Environment "${name}": pipeline mode cannot create the us-east-1 ACM certificate / WAF ` +
          `(cross-region references are incompatible with CDK Pipelines). ` +
          `Create them once via "npx cdk deploy -c env=${name} ${pascal(name)}/KukanGlobalStack", ` +
          `then set certificateArn / webAclArn ${where} — or set enableWaf:false. See ADR-030.`
      )
    }

    const branch = config.deployBranch ?? 'main'
    // The Web Function zip is built during synth, by Docker, its DuckDB
    // extensions installed on arm64 natively (ADR-068 §決定 7). On before
    // any switch: the commit that sets web-function is synthesized by the
    // synth project as it was, and only a passing synth updates it
    // (self-mutation). An x86_64 environment (no ARM CodeBuild) gets it with
    // web-function, deploying the pipeline stack by hand before that push.
    const arch = resolveCpuArchitecture(config)
    const dockerSynth = arch === 'arm64' || resolveWebCompute(config) === 'web-function'
    const { account: targetAccount, region } = resolveEnv(config)
    const stage = new KukanStage(stageScope, pascal(name), {
      env: { account: targetAccount, region },
      config,
    })

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: `kukan-${name}`,
      crossAccountKeys: targetAccount !== this.account,
      // An environment in another region gets a support stack there; reused, it
      // would be the first pipeline's, updated by every other pipeline's self-mutation
      reuseCrossRegionSupportStacks: false,
      dockerEnabledForSynth: dockerSynth,
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection(config.githubRepo, branch, {
          connectionArn: props.connectionArn,
        }),
        commands: [
          'sh scripts/install-pnpm.sh',
          'pnpm install --frozen-lockfile',
          // The whole app is synthesized either way; this names whose assets
          // are bundled — this environment's, not every pipeline's (the Web
          // Function zip is built in the bundling, ADR-068)
          `cd infra && npx cdk synth --exclusively ${this.node.id} '${stage.node.path}/**'`,
        ],
        primaryOutputDirectory: 'infra/cdk.out',
      }),
      // The default SMALL (3 GB) instance OOM-kills the Next.js type checker
      // inside the web image build with no diagnostics ("Failed to type
      // check."), so asset publishing gets the next size up. ARM's MEDIUM is
      // the same 8 GB.
      assetPublishingCodeBuildDefaults: {
        buildEnvironment: {
          computeType: codebuild.ComputeType.MEDIUM,
          buildImage: ARCHITECTURES[arch].assetBuildImage,
        },
      },
      synthCodeBuildDefaults: {
        // ARM for the zip's arm64 stage (above), and the memory asset
        // publishing has for the Next.js build in it
        ...(dockerSynth && {
          buildEnvironment: {
            computeType: codebuild.ComputeType.MEDIUM,
            buildImage: ARCHITECTURES.arm64.assetBuildImage,
          },
        }),
        // Name the Node major instead of taking the image's default, which
        // CodeBuild moves as versions reach end of life.
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: { install: { 'runtime-versions': { nodejs: NODE_MAJOR } } },
        }),
        rolePolicy: [
          // Allow CDK context lookups (AZs, CloudFront prefix list via
          // PrefixList.fromLookup) during synth by assuming the bootstrap lookup
          // role. Lets synth succeed even when cdk.context.json is not committed.
          // Committing cdk.context.json is still recommended for determinism (ADR-031).
          new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: ['arn:aws:iam::*:role/cdk-*-lookup-role-*'],
          }),
        ],
      },
    })

    pipeline.addStage(stage)

    // Built here, now that the stage is in: the strip and the notification
    // attach to the underlying CodePipeline, which CDK Pipelines only
    // materializes on buildPipeline()
    pipeline.buildPipeline()
    deployFromTemplatesOnly(this, pipeline.pipeline, ARCHITECTURES[arch].assetBuildImage)

    if (config.deployNotification) {
      new DeployNotificationConstruct(this, 'Notify', {
        pipeline: pipeline.pipeline,
        environmentName: name,
        siteStacks: Object.fromEntries(
          // An environment without `sites` still deploys one site, out of the
          // all-in-one KukanStack — it is just not named after itself.
          config.sites?.length
            ? config.sites.map((site) => [
                siteStackId(site.name),
                entry(site.name, site.domainName),
              ])
            : [[MAIN_STACK_ID, entry(name, config.domainName)]]
        ),
      })
    }
  }
}

/**
 * Hand CloudFormation the synth output without its assets. CDK Pipelines gives
 * every deploy action the whole cloud assembly, and an action's input artifact
 * may be at most 256 MB. The assets in it — the Docker build contexts, and the
 * Web Function zips built during synth (ADR-068 §決定 7), one per brand, which
 * pass that limit at two brands — are only uploaded, never read by
 * CloudFormation. So an action beside the asset publishers copies the output
 * without the `asset.*` entries, and the deploy actions, all in later stages,
 * are pointed at the copy.
 */
function deployFromTemplatesOnly(
  scope: Construct,
  pipeline: codepipeline.Pipeline,
  buildImage: codebuild.IBuildImage
): void {
  const synthOutput = pipeline.stages
    .flatMap((stage) => stage.actions)
    .flatMap((action) => action.actionProperties.outputs ?? [])
    .find((artifact) => artifact.artifactName === SYNTH_OUTPUT)
  const assets = pipeline.stages.find((stage) => stage.stageName === ASSETS_STAGE)
  // CDK Pipelines' own names, and its own split of a full Assets stage into
  // Assets.1, Assets.2: fail the synth rather than the deployment
  if (!synthOutput || !assets) {
    throw new Error(`${pipeline.node.path}: no ${SYNTH_OUTPUT} or ${ASSETS_STAGE}`)
  }
  if (assets.actions.length >= MAX_ACTIONS_PER_STAGE) {
    throw new Error(
      `${pipeline.node.path}: no room for StripAssets in a full ${ASSETS_STAGE} stage`
    )
  }

  assets.addAction(
    new actions.CodeBuildAction({
      actionName: 'StripAssets',
      input: synthOutput,
      outputs: [new codepipeline.Artifact(TEMPLATES_ONLY)],
      project: new codebuild.PipelineProject(scope, 'StripAssets', {
        // SMALL said outright: an ARM image defaults to LARGE, and this only copies files
        environment: { buildImage, computeType: codebuild.ComputeType.SMALL },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            build: { commands: ['find . -maxdepth 1 -name "asset.*" -exec rm -rf {} +'] },
          },
          artifacts: { files: ['**/*'] },
        }),
      }),
    })
  )

  // The deploy actions are CDK Pipelines' own, so the copy is wired in on the
  // rendered pipeline: same paths, the other artifact
  // The L1's shape, not the template's
  type ResolvedStage = {
    actions: {
      actionTypeId: { provider: string }
      inputArtifacts?: { name: string }[]
      configuration?: Record<string, unknown>
    }[]
  }
  const cfn = pipeline.node.defaultChild as codepipeline.CfnPipeline
  const stages = cdk.Stack.of(pipeline).resolve(cfn.stages) as ResolvedStage[]
  const prefix = `${SYNTH_OUTPUT}::`
  stages.forEach((stage, i) =>
    stage.actions.forEach((action, j) => {
      if (action.actionTypeId.provider !== 'CloudFormation') return
      const at = `Stages.${i}.Actions.${j}`
      action.inputArtifacts?.forEach((input, k) => {
        if (input.name === SYNTH_OUTPUT) {
          cfn.addPropertyOverride(`${at}.InputArtifacts.${k}.Name`, TEMPLATES_ONLY)
        }
      })
      for (const key of ['TemplatePath', 'TemplateConfiguration'] as const) {
        const value = action.configuration?.[key]
        if (typeof value === 'string' && value.startsWith(prefix)) {
          cfn.addPropertyOverride(
            `${at}.Configuration.${key}`,
            `${TEMPLATES_ONLY}::${value.slice(prefix.length)}`
          )
        }
      }
    })
  )
}
