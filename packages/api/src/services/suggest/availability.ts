/**
 * Single source of truth for "can this deployment generate suggestions right
 * now, and with which model" (ADR-040). Shared by the public capability flag
 * (site route) and the suggest endpoint so the UI's button and the 503 gate
 * can never disagree.
 */

import type { AIAdapter, CompletionInfo } from '@kukan/ai-adapter'
import type { Env } from '@kukan/shared'
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

/**
 * The model this deployment writes abstracts with, or null where it writes none
 * (ADR-053).
 *
 * The named model is the switch: there is no "on but unset" state to reconcile,
 * and no fallback to whatever is first in the allow-list — the measurements say
 * the wrong model there does not produce worse abstracts, it produces invented
 * ones. A model outside the allow-list is refused for the same reason it is
 * refused for suggestions: it is not one this deployment may invoke.
 *
 * Here, beside {@link getSuggestAvailability}, so the page's notice, the
 * admin control and the worker cannot disagree about whether abstracts exist.
 */
export function getSummaryModel(env: Pick<Env, 'AI_SUMMARY_MODEL'>, ai: AIAdapter): string | null {
  const model = env.AI_SUMMARY_MODEL
  if (!model) return null
  const info = ai.getCompletionInfo()
  if (!info || !info.allowlist.includes(model)) return null
  return model
}
