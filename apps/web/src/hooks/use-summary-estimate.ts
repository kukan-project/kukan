import { useFetch } from './use-fetch'

/** What one of the two generations would cover, and roughly cost (ADR-053 §11.2) */
export interface SummaryEstimateOperation {
  resources: number
  estimatedInputTokens: { low: number; high: number }
  estimatedOutputTokens: number
  /** Both token counts priced at the model's rate; null where none is recorded */
  estimatedCostUsd: { low: number; high: number } | null
}

export interface SummaryEstimate {
  /** The model that would write them */
  model: string | null
  /** And the language they would be written in */
  locale: 'ja' | 'en'
  /** Abstracts that are missing */
  fill: SummaryEstimateOperation
  /** Those, plus the ones another model, prompt version or language wrote */
  refresh: SummaryEstimateOperation
  skipped: { tooLarge: number; unsupportedFormat: number; noMaterial: number }
}

/**
 * What a generation would cover, asked before it is started.
 *
 * This is the one control in the catalog that spends money per resource, so
 * the numbers come before the button rather than after it.
 */
export function useSummaryEstimate(enabled: boolean) {
  const { data, loading, error } = useFetch<SummaryEstimate>(
    enabled ? '/api/v1/admin/summary-estimate' : null
  )
  return { estimate: data ?? null, loading, error }
}
