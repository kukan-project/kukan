/**
 * KUKAN Search REST API Routes
 * /api/v1/search endpoint
 */

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { userOrgMembership } from '@kukan/db'
import type { SearchFilters } from '@kukan/search-adapter'
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

  const db = c.get('db')
  const user = c.get('user')
  const searchAdapter = c.get('search')

  // Resolve user's org memberships for visibility
  let userOrgIds: string[] | undefined
  if (user && !user.sysadmin) {
    const memberships = await db
      .select({ organizationId: userOrgMembership.organizationId })
      .from(userOrgMembership)
      .where(eq(userOrgMembership.userId, user.id))
    userOrgIds = memberships.map((m) => m.organizationId)
  }

  // Build filters with visibility controls
  const filters: SearchFilters = {
    ...(organization && { organization }),
    ...(tags && { tags: tags.split(',').map((t) => t.trim()) }),
    ...(!user?.sysadmin && {
      excludePrivate: true,
      ...(userOrgIds?.length && { allowPrivateOrgIds: userOrgIds }),
    }),
  }

  const result = await searchAdapter.search({
    q,
    offset,
    limit,
    filters,
  })

  return c.json(result)
})
