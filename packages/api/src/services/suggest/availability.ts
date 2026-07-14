/**
 * Single source of truth for "can this deployment generate suggestions right
 * now, and with which model" (ADR-040). Shared by the public capability flag
 * (site route) and the suggest endpoint so the UI's button and the 503 gate
 * can never disagree.
 */

import type { AIAdapter, CompletionInfo } from '@kukan/ai-adapter'
import {
  AI_SUGGEST_ENABLED_KEY,
  AI_SUGGEST_MODEL_KEY,
  type SystemSettingService,
} from '../system-setting'

export interface SuggestAvailability {
  provider: string
  /** Effective model: runtime setting, falling back to the provider default */
  model: string
}

/**
 * The model a request should use: the saved setting when it is still allowed,
 * otherwise the provider default. Keeps a stale saved model — e.g. one dropped
 * from AI_COMPLETION_MODELS on a redeploy — from being invoked and failing.
 */
export function resolveEffectiveModel(info: CompletionInfo, savedModel: string): string {
  if (savedModel && info.allowlist.includes(savedModel)) return savedModel
  return info.defaultModel
}

/** null when the adapter cannot generate or the kill switch is off */
export async function getSuggestAvailability(
  ai: AIAdapter,
  settings: SystemSettingService
): Promise<SuggestAvailability | null> {
  const info = ai.getCompletionInfo()
  if (!info || !(await settings.getSetting(AI_SUGGEST_ENABLED_KEY))) return null
  const model = resolveEffectiveModel(info, await settings.getSetting(AI_SUGGEST_MODEL_KEY))
  return { provider: info.provider, model }
}
