/**
 * Map a completion-provider error to a stable hint code the admin UI turns into
 * an actionable setup instruction (ADR-040). Returns null for errors that
 * aren't a known setup problem, so the UI falls back to the raw message.
 * Matching is loose and provider-scoped because SDK wording drifts.
 */
export function classifyCompletionError(provider: string | null, message: string): string | null {
  const m = message.toLowerCase()
  if (provider === 'bedrock') {
    if (m.includes('bedrock:invokemodel') && m.includes('not authorized')) return 'bedrock-iam'
    if (m.includes('use case details have not been submitted')) return 'bedrock-use-case'
    if (m.includes('aws-marketplace:subscribe') || m.includes('subscription for this model')) {
      return 'bedrock-marketplace'
    }
  }
  if (provider === 'ollama') {
    if (m.includes('econnrefused') || m.includes('fetch failed') || m.includes('connect')) {
      return 'ollama-unreachable'
    }
    if (m.includes('not found') || m.includes('try pulling') || m.includes('no such model')) {
      return 'ollama-model-missing'
    }
  }
  if (provider === 'openai') {
    if (m.includes('api key') || m.includes('401') || m.includes('unauthorized'))
      return 'openai-auth'
    if (m.includes('does not exist') || m.includes('model not found')) return 'openai-model-missing'
  }
  return null
}
