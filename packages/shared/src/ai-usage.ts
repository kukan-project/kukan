/**
 * What AI calls are recorded as, and what a recorded call cost.
 */

import { requestUsd, tokenRate } from './summary'

/** What a call was spent on — one per caller, so a bill can be read by purpose */
export const AI_USAGE_PURPOSES = [
  'summarize',
  'suggest',
  'connection-test',
  'embed-resource',
  'embed-query',
] as const
export type AiUsagePurpose = (typeof AI_USAGE_PURPOSES)[number]

/**
 * Purposes recorded as sums per quarter hour rather than a row per call: made
 * once per search, too many for rows that say nothing a sum does not
 */
export const SUMMED_AI_USAGE_PURPOSES: ReadonlySet<AiUsagePurpose> = new Set(['embed-query'])

export const AI_PROVIDERS = ['bedrock', 'openai', 'ollama'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

/** What the usage report cuts by, in the site's time zone */
export const AI_USAGE_GRANULARITIES = ['hour', 'day', 'month'] as const
export type AiUsageGranularity = (typeof AI_USAGE_GRANULARITIES)[number]

/** One bucket of the report (GET /api/v1/admin/ai-usage) */
export interface AiUsageBucket {
  /** Start of the hour, day or month, as an instant */
  start: string
  purpose: AiUsagePurpose
  provider: AiProvider
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  unpricedCalls: number
}

export interface AiUsageMonth {
  costUsd: number
  calls: number
  unpricedCalls: number
  /** This month's cost so far, carried at the same rate to the month's end;
   *  null until a day of it has passed */
  projectedUsd: number | null
}

export interface AiUsageReport {
  granularity: AiUsageGranularity
  timeZone: string
  /** Every bucket start in the window, oldest first — buckets with no calls included */
  periods: string[]
  buckets: AiUsageBucket[]
  month: AiUsageMonth
}

/** Tokens one call consumed, as the provider reported them */
export interface AiUsageTokens {
  /** Uncached input only, where the provider splits out the cached part */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * USD for one call at list price, or null where it cannot be told.
 *
 * Each provider is priced its own way: Bedrock from the rate table (profile
 * prefix included), a local Ollama model at nothing, and OpenAI — mostly a
 * connector for compatible servers whose cost is not per token — not at all.
 * A call whose input went unreported is unpriced rather than free: a total
 * that silently leaves it out reads lower than the bill.
 */
export function usageCostUsd(
  provider: AiProvider,
  model: string,
  usage: AiUsageTokens
): number | null {
  if (provider === 'ollama') return 0
  if (provider !== 'bedrock' || usage.inputTokens === undefined) return null
  const rate = tokenRate(model)
  if (!rate) return null
  return requestUsd(rate, usage.inputTokens ?? 0, usage.outputTokens ?? 0, {
    read: usage.cacheReadTokens,
    write: usage.cacheWriteTokens,
  })
}
