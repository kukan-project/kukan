/**
 * KUKAN Search REST API Routes
 * /api/v1/search endpoint
 */

import { Hono } from 'hono'
import type { AppContext } from '../context'

export const searchRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/search - Full-text search via SearchAdapter
searchRouter.get('/', async (c) => {
  // Manual query parameter parsing and validation
  const q = c.req.query('q')
  const offset = parseInt(c.req.query('offset') || '0', 10)
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const organization = c.req.query('organization')
  const tags = c.req.query('tags')

  // Validate q parameter
  if (!q || q.trim().length === 0) {
    return c.json(
      {
        type: 'about:blank',
        title: 'VALIDATION_ERROR',
        status: 400,
        detail: 'Search query (q) is required',
      },
      400
    )
  }

  // Validate numeric parameters
  if (isNaN(offset) || offset < 0) {
    return c.json(
      {
        type: 'about:blank',
        title: 'VALIDATION_ERROR',
        status: 400,
        detail: 'offset must be a non-negative number',
      },
      400
    )
  }

  if (isNaN(limit) || limit < 1 || limit > 100) {
    return c.json(
      {
        type: 'about:blank',
        title: 'VALIDATION_ERROR',
        status: 400,
        detail: 'limit must be between 1 and 100',
      },
      400
    )
  }

  const searchAdapter = c.get('search')

  // Build filters from query params
  const filters: Record<string, unknown> = {}
  if (organization) {
    filters.organization = organization
  }
  if (tags) {
    filters.tags = tags.split(',').map((t) => t.trim())
  }

  const result = await searchAdapter.search({
    q,
    offset,
    limit,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  })

  return c.json(result)
})
