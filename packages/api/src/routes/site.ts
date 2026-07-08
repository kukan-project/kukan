/**
 * KUKAN Public Site Routes
 * /api/v1/site endpoints (unauthenticated)
 */

import { Hono } from 'hono'
import { publicCache } from '../middleware/cache-control'
import { SEMANTIC_SEARCH_ENABLED_KEY, SEARCH_EXAMPLE_QUERIES_KEY } from '../services/system-setting'
import type { AppContext } from '../context'

export const siteRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/site/settings — Public site settings for the frontend
siteRouter.get('/settings', publicCache(), async (c) => {
  const settings = c.get('settings')
  const [semanticSetting, searchExampleQueries] = await Promise.all([
    settings.getSetting(SEMANTIC_SEARCH_ENABLED_KEY),
    settings.getSetting(SEARCH_EXAMPLE_QUERIES_KEY),
  ])
  // Lets the search UI hide semantic-search affordances (toggle, natural-
  // language placeholder) when the vector leg cannot or must not run
  const semanticSearchEnabled =
    c.get('ai').getEmbeddingInfo() !== null &&
    typeof c.get('dbSearch').searchByVector === 'function' &&
    semanticSetting
  return c.json({
    registrationEnabled: c.get('env').REGISTRATION_ENABLED,
    semanticSearchEnabled,
    searchExampleQueries,
  })
})
