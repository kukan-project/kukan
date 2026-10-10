/**
 * Shared AI model configuration — the single source of truth for the CDK
 * infra (IAM grants) and the runtime adapters.
 */

/** Default Bedrock completion model when none is configured (ADR-040).
 *  A jp. cross-region inference profile keeps inference within Tokyo/Osaka.
 *  Haiku 5.5 rather than Nova: a suggestion costs less than half as much
 *  (ADR-040, 2026-10 addendum), and Nova cannot write the abstracts (ADR-053,
 *  appendices 18 and 20). An Anthropic model needs the account's one-time
 *  use-case form and Marketplace subscription before the first call. */
export const DEFAULT_BEDROCK_COMPLETION_MODEL = 'jp.anthropic.claude-haiku-5-5'

/** Parse the AI_COMPLETION_MODELS env value (comma-separated model IDs) */
export function parseCompletionModels(csv: string | undefined): string[] | undefined {
  if (!csv) return undefined
  const models = [
    ...new Set(
      csv
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    ),
  ]
  return models.length ? models : undefined
}

/** Providers that run local models — edit UIs show a quality caveat for these
 *  (ADR-040 evaluation). One definition for server routes and client UI. */
export function isLocalAIProvider(provider: string | null | undefined): boolean {
  return provider === 'ollama'
}
