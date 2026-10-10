/**
 * KUKAN Metered AI Adapter
 * Records what every call consumed, and what it was spent on
 */

import type { AiProvider, AiUsagePurpose, AiUsageTokens } from '@kukan/shared/ai-usage'
import type {
  AIAdapter,
  CompleteOptions,
  CompletionInfo,
  DocumentInfo,
  EmbedOptions,
  EmbeddingInfo,
} from './adapter'

/** What a call is spent on, named by the caller — the adapter cannot know it */
export interface UsageTag {
  purpose: AiUsagePurpose
  resourceId?: string
}

export interface AiUsageEvent extends AiUsageTokens {
  provider: AiProvider
  model: string
  purpose: AiUsagePurpose
  resourceId?: string
  at: Date
}

/** Takes one event per successful call. Must not throw or block the caller. */
export type AiUsageSink = (event: AiUsageEvent) => void

/**
 * The adapter the application calls: the same as {@link AIAdapter}, except
 * that every call names its purpose. Required rather than optional so a new
 * caller that forgets it does not type-check, instead of going unrecorded;
 * branded so a bare provider adapter cannot be passed where this is expected.
 * (The other way round TypeScript cannot refuse — methods compare bivariantly
 * — so the tag is checked again at run time.)
 */
export interface MeteredAI extends AIAdapter {
  readonly metered: true
  complete(prompt: string, options: CompleteOptions & { usage: UsageTag }): Promise<string>
  embed(text: string, options: EmbedOptions & { usage: UsageTag }): Promise<number[]>
  embedBatch(texts: string[], options: EmbedOptions & { usage: UsageTag }): Promise<number[][]>
}

/** Wrap a provider adapter so each call it completes is handed to `sink` */
export function meterAI(inner: AIAdapter, sink: AiUsageSink): MeteredAI {
  return new MeteredAIAdapter(inner, sink)
}

/**
 * The tag, or a plain error where there is none. A metered adapter can still
 * be reached through the AIAdapter type, whose options are optional; failing
 * loud there keeps an unnamed call from going unrecorded.
 */
function requireTag<T extends object>(options: (T & { usage?: UsageTag }) | undefined) {
  if (!options?.usage) throw new Error('An AI call must name its purpose (options.usage)')
  return options as T & { usage: UsageTag }
}

class MeteredAIAdapter implements MeteredAI {
  readonly metered = true

  constructor(
    private readonly inner: AIAdapter,
    private readonly sink: AiUsageSink
  ) {}

  async complete(prompt: string, options: CompleteOptions & { usage: UsageTag }): Promise<string> {
    const { usage: tag, ...rest } = requireTag(options)
    const model = rest.model || this.inner.getCompletionInfo()?.defaultModel || 'unknown'
    return this.inner.complete(prompt, { ...rest, onUsage: this.forward(tag, model, rest.onUsage) })
  }

  async embed(text: string, options: EmbedOptions & { usage: UsageTag }): Promise<number[]> {
    const { usage: tag, ...rest } = requireTag(options)
    return this.inner.embed(text, {
      ...rest,
      onUsage: this.forward(tag, this.embeddingModel, rest.onUsage),
    })
  }

  async embedBatch(
    texts: string[],
    options: EmbedOptions & { usage: UsageTag }
  ): Promise<number[][]> {
    const { usage: tag, ...rest } = requireTag(options)
    return this.inner.embedBatch(texts, {
      ...rest,
      onUsage: this.forward(tag, this.embeddingModel, rest.onUsage),
    })
  }

  getCompletionInfo(): CompletionInfo | null {
    return this.inner.getCompletionInfo()
  }

  listCompletionModels(): Promise<string[]> {
    return this.inner.listCompletionModels()
  }

  getEmbeddingInfo(): EmbeddingInfo | null {
    return this.inner.getEmbeddingInfo()
  }

  getDocumentInfo(): DocumentInfo | null {
    return this.inner.getDocumentInfo()
  }

  private get embeddingModel(): string {
    return this.inner.getEmbeddingInfo()?.model ?? 'unknown'
  }

  /** Record the usage, then hand it on to the caller's own callback */
  private forward(
    tag: UsageTag,
    model: string,
    own: ((usage: AiUsageTokens) => void) | undefined
  ): (usage: AiUsageTokens) => void {
    return (usage) => {
      // Every adapter that reports usage also describes its completions
      const provider = this.inner.getCompletionInfo()?.provider
      try {
        if (provider) this.sink({ ...usage, provider, model, ...tag, at: new Date() })
      } catch {
        // A recorder fault must not fail a call that has already been paid for
      }
      own?.(usage)
    }
  }
}
