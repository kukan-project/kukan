/**
 * KUKAN CI/CD Pipeline Stack (ADR-030).
 * CDK Pipelines (AWS CodePipeline) with a CodeConnections (GitHub App) source.
 * One self-mutating pipeline per environment, triggered by that env's branch.
 */

import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines'
import { Construct } from 'constructs'
import { needsGlobalStack, resolveEnv, type EnvironmentConfig } from './config.js'
import { pascal } from './naming.js'
import { KukanStage } from './kukan-stage.js'

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
      if (!config.githubRepo) continue

      // CDK Pipelines cannot create the us-east-1 cert/WAF (cross-region is incompatible).
      // Fail early with an actionable message instead of a cryptic synthesizer error.
      if (needsGlobalStack(config)) {
        throw new Error(
          `Environment "${name}": pipeline mode cannot create the us-east-1 ACM certificate / WAF ` +
            `(cross-region references are incompatible with CDK Pipelines). ` +
            `Create them once via "npx cdk deploy -c env=${name} ${pascal(name)}/KukanGlobalStack", ` +
            `then set certificateArn / webAclArn in config/environments.ts — or set enableWaf:false. See ADR-030.`
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
    }
  }
}
