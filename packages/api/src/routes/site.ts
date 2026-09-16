/**
 * KUKAN Public Site Routes
 * /api/v1/site endpoints (unauthenticated)
 */

import { Hono } from 'hono'
import { isLocalAIProvider } from '@kukan/shared/ai'
import { passwordMinScore } from '@kukan/shared'
import { publicCache } from '../middleware/cache-control'
import { isRegistrationAllowed } from '../services/bootstrap'
import { SEMANTIC_SEARCH_ENABLED_KEY, SEARCH_EXAMPLE_QUERIES_KEY } from '../services/system-setting'
import { getSuggestAvailability, getSummaryModel } from '../services/suggest/availability'
import type { AppContext } from '../context'

export const siteRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/site/settings — Public site settings for the frontend
siteRouter.get('/settings', publicCache(), async (c) => {
  const settings = c.get('settings')
  const [registrationEnabled, semanticSetting, searchExampleQueries, suggestAvailability] =
    await Promise.all([
      // Effective value: forced on while the user table is empty (ADR-038)
      isRegistrationAllowed(c.get('db'), settings),
      settings.getSetting(SEMANTIC_SEARCH_ENABLED_KEY),
      settings.getSetting(SEARCH_EXAMPLE_QUERIES_KEY),
      getSuggestAvailability(c.get('ai'), settings),
    ])
  // Lets the search UI hide semantic-search affordances (toggle, natural-
  // language placeholder) when the vector leg cannot or must not run
  const semanticSearchEnabled =
    c.get('ai').getEmbeddingInfo() !== null &&
    typeof c.get('dbSearch').searchByVector === 'function' &&
    semanticSetting
  // Lets dataset edit UIs show/hide the AI suggestion button (ADR-040). Same
  // predicate as the suggest endpoint's 503 gate, so they cannot disagree
  const metadataSuggestEnabled = suggestAvailability !== null
  // Whether this deployment writes abstracts at all (ADR-053 §6.1). The page
  // reads it to tell "there is no abstract for this file" apart from "this
  // catalog does not have them", and the admin screen to decide whether the
  // language setting and the generate control mean anything here.
  const resourceSummaryEnabled = getSummaryModel(c.get('env'), c.get('ai')) !== null
  return c.json({
    registrationEnabled,
    semanticSearchEnabled,
    searchExampleQueries,
    metadataSuggestEnabled,
    // Local models get a quality caveat in edit UIs (ADR-040 evaluation)
    metadataSuggestLocalModel: isLocalAIProvider(suggestAvailability?.provider),
    resourceSummaryEnabled,
    // The strength meter judges by the number this deployment enforces, so it
    // cannot pass a password the sign-up endpoint is about to refuse
    passwordMinScore: passwordMinScore(),
  })
})
