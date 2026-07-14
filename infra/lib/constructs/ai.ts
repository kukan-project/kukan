/**
 * Bedrock embedding wiring shared by the web and worker services (ADR-034).
 */

import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as ecs from 'aws-cdk-lib/aws-ecs'
import type { KukanConfig } from '../config.js'

/**
 * Configure a task for Bedrock embedding: container env vars plus InvokeModel
 * scoped to the configured model. The model ID is resolved in loadConfig, so
 * the env var and the IAM scope cannot diverge. Without `config.bedrock` the
 * task runs with AI disabled.
 */
export function configureBedrockEmbedding(
  config: KukanConfig,
  taskDef: ecs.FargateTaskDefinition,
  environment: Record<string, string>
): void {
  if (!config.bedrock) {
    environment.AI_TYPE = 'none'
    return
  }
  const { region, embeddingModel, embeddingDimensions, vectorMinSimilarity } = config.bedrock
  const bedrockRegion = region ?? cdk.Aws.REGION

  environment.AI_TYPE = 'bedrock'
  environment.BEDROCK_REGION = bedrockRegion
  environment.AI_EMBEDDING_MODEL = embeddingModel
  // Omitted → the model's measured recommendation, held by the AI adapter
  if (vectorMinSimilarity != null) {
    environment.SEARCH_VECTOR_MIN_SIMILARITY = String(vectorMinSimilarity)
  }
  if (embeddingDimensions != null) {
    environment.AI_EMBEDDING_DIMENSIONS = String(embeddingDimensions)
  }

  taskDef.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      // Foundation-model ARNs have no account segment
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:${bedrockRegion}::foundation-model/${embeddingModel}`,
      ],
    })
  )
}

/** Cross-region inference profile geo prefixes (AWS-defined region groups). */
const PROFILE_PREFIX = /^(?:us-gov|us|eu|apac|jp|au|ca|global)\./

/**
 * Configure a task for Bedrock AI metadata suggestions (ADR-040): pass the
 * allowed completion models as an env var and grant InvokeModel on exactly
 * those. Only the web service generates suggestions, so the worker skips this.
 * The env list is the single source of truth — the admin model picker offers
 * these, so every choice is guaranteed invokable.
 *
 * A cross-region inference profile also needs its underlying foundation model
 * in every member region, so that region is wildcarded — but scoped by an
 * InferenceProfileArn condition so a bare base-model ID cannot be invoked
 * outside the profile allow-list.
 */
export function configureBedrockCompletion(
  config: KukanConfig,
  taskDef: ecs.FargateTaskDefinition,
  environment: Record<string, string>
): void {
  if (!config.bedrock) return
  const { region, completionModels } = config.bedrock
  const bedrockRegion = region ?? cdk.Aws.REGION
  const partition = cdk.Aws.PARTITION

  environment.AI_COMPLETION_MODELS = completionModels.join(',')

  const profileArns: string[] = [] // inference profiles, invoked directly
  const profiledModels: string[] = [] // their underlying foundation models
  const directModels: string[] = [] // bare on-demand foundation models

  for (const model of completionModels) {
    if (PROFILE_PREFIX.test(model)) {
      profileArns.push(
        `arn:${partition}:bedrock:${bedrockRegion}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${model}`
      )
      profiledModels.push(
        `arn:${partition}:bedrock:*::foundation-model/${model.replace(PROFILE_PREFIX, '')}`
      )
    } else {
      directModels.push(`arn:${partition}:bedrock:${bedrockRegion}::foundation-model/${model}`)
    }
  }

  if (profileArns.length) {
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: profileArns })
    )
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: profiledModels,
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArns } },
      })
    )
  }
  if (directModels.length) {
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: directModels })
    )
  }
}
