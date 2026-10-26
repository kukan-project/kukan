/**
 * Bedrock embedding wiring shared by the web and worker services (ADR-034).
 */

import { createHash } from 'node:crypto'
import * as cdk from 'aws-cdk-lib'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as ecs from 'aws-cdk-lib/aws-ecs'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'

/** Model ID → the ARN of the site's application inference profile for it. */
export type BedrockProfiles = ReadonlyMap<string, string>

/** Cross-region inference profile geo prefixes (AWS-defined region groups). */
const PROFILE_PREFIX = /^(?:us-gov|us|eu|apac|jp|au|ca|global)\./

/** The cross-region inference profile or foundation model `model` names. */
function modelArn(model: string, region: string): string {
  return PROFILE_PREFIX.test(model)
    ? `arn:${cdk.Aws.PARTITION}:bedrock:${region}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${model}`
    : `arn:${cdk.Aws.PARTITION}:bedrock:${region}::foundation-model/${model}`
}

/**
 * One application inference profile per model the site uses: called through
 * them, Bedrock bills the stack's cost allocation tags, which a model ID cannot
 * carry. A profile answers only in its own region, so with Bedrock called in
 * another there are none, and the app calls the model IDs.
 */
export class BedrockProfilesConstruct extends Construct {
  readonly arns = new Map<string, string>()

  constructor(scope: Construct, id: string, config: KukanConfig) {
    super(scope, id)
    if (!config.bedrock) return
    const { region, embeddingModel, completionModels } = config.bedrock
    if (region && region !== cdk.Stack.of(this).region) return

    for (const model of new Set([embeddingModel, ...completionModels])) {
      // A model ID can run past the 64-character name limit once prefixed
      const key = createHash('sha256').update(model).digest('hex').slice(0, 8)
      const profile = new bedrock.CfnApplicationInferenceProfile(this, key, {
        // Unlike the other names, it may not hold `--`, which an environment name may
        inferenceProfileName: resourceName(this, `ai-${key}`).replace(/-{2,}/g, '-'),
        description: model,
        modelSource: { copyFrom: modelArn(model, cdk.Aws.REGION) },
      })
      this.arns.set(model, profile.attrInferenceProfileArn)
    }
    cdk.Tags.of(this).add('kukan:component', 'ai')
  }
}

/**
 * Configure a task for Bedrock embedding: container env vars plus InvokeModel
 * scoped to the configured model. The model ID is resolved in loadConfig, so
 * the env var and the IAM scope cannot diverge. Without `config.bedrock` the
 * task runs with AI disabled.
 */
export function configureBedrockEmbedding(
  config: KukanConfig,
  profiles: BedrockProfiles,
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

  // The app swaps in a profile where it has one (BEDROCK_INFERENCE_PROFILES)
  if (profiles.size) {
    environment.BEDROCK_INFERENCE_PROFILES = cdk.Stack.of(taskDef).toJsonString(
      Object.fromEntries(profiles)
    )
  }
  const profile = profiles.get(embeddingModel)
  taskDef.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      // Foundation-model ARNs have no account segment
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:${bedrockRegion}::foundation-model/${embeddingModel}`,
        ...(profile ? [profile] : []),
      ],
    })
  )
}

/**
 * Configure a task for Bedrock text generation: pass the allowed completion
 * models as an env var and grant InvokeModel on exactly those. Both services
 * need it — the web generates metadata suggestions (ADR-040), the worker writes
 * resource abstracts (ADR-053), and both refuse a model outside the list.
 * The env list is the single source of truth — the admin model picker offers
 * these, so every choice is guaranteed invokable.
 *
 * A cross-region inference profile also needs its underlying foundation model
 * in every member region, so that region is wildcarded — but scoped by an
 * InferenceProfileArn condition so a bare base-model ID cannot be invoked
 * outside the profile allow-list. Called through the site's application
 * profile, the call names that profile, so the condition admits it too.
 */
export function configureBedrockCompletion(
  config: KukanConfig,
  profiles: BedrockProfiles,
  taskDef: ecs.FargateTaskDefinition,
  environment: Record<string, string>
): void {
  if (!config.bedrock) return
  const { region, completionModels, summaryModel } = config.bedrock
  const bedrockRegion = region ?? cdk.Aws.REGION
  const partition = cdk.Aws.PARTITION

  environment.AI_COMPLETION_MODELS = completionModels.join(',')
  // Omitted → abstracts off, and nothing is billed for them (ADR-053)
  if (summaryModel) {
    environment.AI_SUMMARY_MODEL = summaryModel
  }

  const invoked: string[] = [] // what the calls name: profiles and models
  const profileArns: string[] = [] // profiles that admit the models below
  const profiledModels: string[] = [] // their underlying foundation models

  for (const model of completionModels) {
    const own = profiles.get(model)
    const named = modelArn(model, bedrockRegion)
    invoked.push(named, ...(own ? [own] : []))
    if (PROFILE_PREFIX.test(model)) {
      profileArns.push(named, ...(own ? [own] : []))
      profiledModels.push(
        `arn:${partition}:bedrock:*::foundation-model/${model.replace(PROFILE_PREFIX, '')}`
      )
    }
  }

  taskDef.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: invoked })
  )
  if (profiledModels.length) {
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: profiledModels,
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArns } },
      })
    )
  }
}
