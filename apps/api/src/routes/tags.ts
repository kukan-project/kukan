/**
 * KUKAN Tags REST API Routes
 * /api/v1/tags endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { TagService } from '../services/tag-service'
import type { AppContext } from '../context'

export const tagsRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/tags - List tags with pagination and search
tagsRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(100),
      q: z.string().optional(),
    })
  ),
  async (c) => {
    const params = c.req.valid('query')
    const service = new TagService(c.get('db'))
    const result = await service.list(params)
    return c.json(result)
  }
)

// GET /api/v1/tags/:id - Get tag by ID
tagsRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const service = new TagService(c.get('db'))
  const tag = await service.getById(id)

  if (!tag) {
    return c.json({ error: 'Tag not found' }, 404)
  }

  return c.json(tag)
})
