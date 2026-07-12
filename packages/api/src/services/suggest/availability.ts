/**
 * Single source of truth for "can this deployment generate suggestions right
 * now, and with which model" (ADR-040). Shared by the public capability flag
 * (site route) and the suggest endpoint so the UI's button and the 503 gate
 * can never disagree.
 */

import type { AIAdapter } from '@kukan/ai-adapter'
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

/** null when the adapter cannot generate or the kill switch is off */
export async function getSuggestAvailability(
  ai: AIAdapter,
  settings: SystemSettingService
): Promise<SuggestAvailability | null> {
  const info = ai.getCompletionInfo()
  if (!info || !(await settings.getSetting(AI_SUGGEST_ENABLED_KEY))) return null
  const model = (await settings.getSetting(AI_SUGGEST_MODEL_KEY)) || info.defaultModel
  return { provider: info.provider, model }
}
