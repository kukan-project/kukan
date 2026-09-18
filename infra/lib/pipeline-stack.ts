/**
 * KUKAN CI/CD Pipeline Stack (ADR-030).
 * CDK Pipelines (AWS CodePipeline) with a CodeConnections (GitHub App) source.
 * One self-mutating pipeline per environment, triggered by that env's branch.
 */

import * as cdk from 'aws-cdk-lib'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines'
import { Construct } from 'constructs'
import { needsGlobalStack, resolveEnv, type EnvironmentConfig } from './config.js'
import { pascal } from './naming.js'
import { KukanStage, MAIN_STACK_ID, siteStackId } from './kukan-stage.js'
import { DeployNotificationConstruct } from './constructs/deploy-notification.js'

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
    const notified: { name: string; config: EnvironmentConfig; pipeline: CodePipeline }[] = []

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
      const { account: targetAccount, region } = resolveEnv(config)

      const pipeline = new CodePipeline(this, `Pipeline${pascal(name)}`, {
        pipelineName: `kukan-${name}`,
        crossAccountKeys: targetAccount !== pipelineAccount,
        synth: new ShellStep('Synth', {
          input: CodePipelineSource.connection(config.githubRepo, branch, {
            connectionArn: props.connectionArn,
          }),
          commands: [
            'corepack enable',
            'pnpm install --frozen-lockfile',
            'cd infra && npx cdk synth',
          ],
          primaryOutputDirectory: 'infra/cdk.out',
        }),
        // The default SMALL (3 GB) instance OOM-kills the Next.js type checker
        // inside the web image build with no diagnostics ("Failed to type
        // check."), so asset publishing gets the next size up.
        assetPublishingCodeBuildDefaults: {
          buildEnvironment: { computeType: codebuild.ComputeType.MEDIUM },
        },
        synthCodeBuildDefaults: {
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

      if (config.deployNotification) notified.push({ name, config, pipeline })
    }

    // After the loop, so nothing can add a stage to a pipeline that has already
    // been built: the notification rule attaches to the underlying CodePipeline,
    // which CDK Pipelines only materializes on buildPipeline().
    for (const { name, config, pipeline } of notified) {
      pipeline.buildPipeline()
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
