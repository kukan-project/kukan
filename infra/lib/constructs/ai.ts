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
