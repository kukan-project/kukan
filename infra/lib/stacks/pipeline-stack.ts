/**
 * KUKAN CI/CD Pipeline Stack (ADR-030).
 * CDK Pipelines (AWS CodePipeline) with a CodeConnections (GitHub App) source.
 * One self-mutating pipeline per environment, triggered by that env's branch.
 */

import * as cdk from 'aws-cdk-lib'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines'
import { Construct } from 'constructs'
import {
  needsGlobalStack,
  resolveCpuArchitecture,
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

export interface KukanPipelineStackProps extends cdk.StackProps {
  /** All environment definitions (config/environments.ts). */
  environments: Record<string, EnvironmentConfig>
  /** CodeConnections connection ARN (ADR-030). */
  connectionArn: string
}

export class KukanPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KukanPipelineStackProps) {
    super(scope, id, props)

    const pipelineAccount = this.account

    for (const [name, config] of Object.entries(props.environments)) {
      // An env without a source repo cannot have a pipeline (deploy it standalone instead).
      if (!config.githubRepo) {
        if (config.deployNotification) {
          throw new Error(
            `Environment "${name}": deployNotification reports on a pipeline's executions, but ` +
              `this environment has no githubRepo and so gets no pipeline. Set githubRepo to ` +
              `deploy it in pipeline mode, or drop deployNotification. See ADR-030.`
          )
        }
        continue
      }

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

      const pipeline = new CodePipeline(this, `Pipeline${pascal(name)}`, {
        pipelineName: `kukan-${name}`,
        crossAccountKeys: targetAccount !== pipelineAccount,
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
            `cd infra && npx cdk synth --exclusively ${this.node.id} '${this.node.id}/${pascal(name)}/**'`,
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

      pipeline.addStage(
        new KukanStage(this, pascal(name), {
          env: { account: targetAccount, region },
          config,
        })
      )

      // Built here, now that the stage is in: the strip and the notification
      // attach to the underlying CodePipeline, which CDK Pipelines only
      // materializes on buildPipeline()
      pipeline.buildPipeline()
      deployFromTemplatesOnly(
        this,
        pascal(name),
        pipeline.pipeline,
        ARCHITECTURES[arch].assetBuildImage
      )

      if (config.deployNotification) {
        new DeployNotificationConstruct(this, `Notify${pascal(name)}`, {
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
  id: string,
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
      project: new codebuild.PipelineProject(scope, `StripAssets${id}`, {
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
