/**
 * KUKAN Search REST API Routes
 * /api/v1/search endpoint
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppContext } from '../context'

export const searchRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/search - Full-text search via SearchAdapter
searchRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      q: z.string().min(1, 'Search query is required'),
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      // Optional filters for future extension
      organization: z.string().optional(),
      tags: z.string().optional(), // Comma-separated
    })
  ),
  async (c) => {
    const params = c.req.valid('query')
    const searchAdapter = c.get('search')

    // Build filters from query params
    const filters: Record<string, unknown> = {}
    if (params.organization) {
      filters.organization = params.organization
    }
    if (params.tags) {
      filters.tags = params.tags.split(',').map((t) => t.trim())
    }

    const result = await searchAdapter.search({
      q: params.q,
      offset: params.offset,
      limit: params.limit,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
    })

    return c.json(result)
  }
)
