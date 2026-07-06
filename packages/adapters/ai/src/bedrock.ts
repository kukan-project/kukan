/**
 * KUKAN Bedrock AI Adapter
 * AWS Bedrock implementation (Phase 5)
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { AIAdapter, CompleteOptions, EmbedOptions, EmbeddingInfo } from './adapter'

export interface BedrockConfig {
  region: string
  modelId?: string
  embeddingModel?: string
  embeddingDimensions?: number
  accessKeyId?: string
  secretAccessKey?: string
}

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
const DEFAULT_EMBEDDING_DIMENSIONS = 1024
/** Titan has no batch embedding API — cap concurrent InvokeModel calls instead */
const EMBED_CONCURRENCY = 8

export class BedrockAIAdapter implements AIAdapter {
  private client: BedrockRuntimeClient
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(config: BedrockConfig) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    })
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
    this.embeddingDimensions = config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error('BedrockAIAdapter.complete not implemented yet (Phase 5)')
  }

  async embed(text: string, _options?: EmbedOptions): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.embeddingModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: this.embeddingDimensions,
        normalize: true,
      }),
    })
    const response = await this.client.send(command)
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding: number[]
    }
    return payload.embedding
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const results: number[][] = new Array(texts.length)
    for (let i = 0; i < texts.length; i += EMBED_CONCURRENCY) {
      const chunk = texts.slice(i, i + EMBED_CONCURRENCY)
      const embedded = await Promise.all(chunk.map((text) => this.embed(text, options)))
      for (let j = 0; j < embedded.length; j++) {
        results[i + j] = embedded[j]
      }
    }
    return results
  }

  getEmbeddingInfo(): EmbeddingInfo {
    return { model: this.embeddingModel, dimensions: this.embeddingDimensions }
  }
}
