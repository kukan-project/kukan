/** Slack notification for a pipeline's deployments (ADR-030). */

import * as cdk from 'aws-cdk-lib'
import * as codestarnotifications from 'aws-cdk-lib/aws-codestarnotifications'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'
import { fileURLToPath } from 'node:url'

export interface DeployNotificationProps {
  /** The pipeline to report on. */
  pipeline: codestarnotifications.INotificationRuleSource
  /** Environment name, as the message's subject. */
  environmentName: string
  /**
   * Site stacks by construct id (`siteStackId`), which is how the stage's
   * deploy actions are named.
   *
   * A site is linked only when it sets `domainName`: the CloudFront domain of
   * a site without one is decided inside the stage's own stack, which the
   * pipeline stack cannot reference (CDK Pipelines deploys stages separately).
   */
  siteStacks: Record<string, { label: string; url?: string }>
}

export class DeployNotificationConstruct extends Construct {
  constructor(scope: Construct, id: string, props: DeployNotificationProps) {
    super(scope, id)

    /**
     * The webhook lives in a secret this stack creates, rather than one made by
     * hand before deploying: the operator pastes the URL once, into a box that
     * is already there.
     *
     * `generateSecretString` rather than a literal placeholder, because a
     * literal is a declared value — CloudFormation would write it back over the
     * real URL on the next deploy. A generated one is set at create and never
     * touched again, which is how the site database's credentials work too.
     */
    const secret = new secretsmanager.Secret(this, 'SlackWebhook', {
      description: `Slack incoming webhook for ${props.environmentName} deploy notifications — paste the URL here`,
      generateSecretString: { passwordLength: 32 },
    })

    /**
     * Lambda caps all of a function's environment variables at 4 KB together,
     * and the limit cannot be raised. An environment may hold up to 50 sites
     * (ADR-049), so a table of long site names and domains can reach it —
     * failing at CreateFunction, which takes the whole pipeline stack with it.
     * Stop at synth instead, with the size named. The budget leaves room for
     * the two other variables (a secret ARN and the environment name).
     */
    const siteStacks = JSON.stringify(props.siteStacks)
    if (siteStacks.length > 3072) {
      throw new Error(
        `Environment "${props.environmentName}": the deploy notification's site table is ` +
          `${siteStacks.length} bytes, past the 3072 a Lambda environment variable can carry ` +
          `here (4 KB for all of them, not raisable). Shorten the site names or their domains, ` +
          `or drop deployNotification for this environment.`
      )
    }

    const handler = new lambdaNodejs.NodejsFunction(this, 'Handler', {
      entry: fileURLToPath(new URL('../lambda/deploy-notification/index.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        WEBHOOK_SECRET_ARN: secret.secretArn,
        KUKAN_ENVIRONMENT: props.environmentName,
        SITE_STACKS: siteStacks,
      },
      logGroup: new logs.LogGroup(this, 'HandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
      bundling: { minify: false, sourcesContent: false },
    })
    secret.grantRead(handler)
    // The notification says only that an execution changed state; what it
    // deployed and from which commit has to be asked afterwards.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codepipeline:GetPipelineExecution', 'codepipeline:ListActionExecutions'],
        resources: ['*'],
      })
    )

    // CodeStar Notifications delivers to SNS, not to a function.
    const topic = new sns.Topic(this, 'Topic', {
      displayName: `kukan-${props.environmentName}-deploy`,
    })
    topic.addSubscription(new subscriptions.LambdaSubscription(handler))

    new codestarnotifications.NotificationRule(this, 'Rule', {
      source: props.pipeline,
      events: [
        'codepipeline-pipeline-pipeline-execution-succeeded',
        'codepipeline-pipeline-pipeline-execution-failed',
      ],
      targets: [topic],
      detailType: codestarnotifications.DetailType.FULL,
    })

    new cdk.CfnOutput(this, 'SlackWebhookSecretArn', {
      value: secret.secretArn,
      description: `Paste the Slack incoming webhook URL into this secret to turn on ${props.environmentName} deploy notifications`,
    })
  }
}
