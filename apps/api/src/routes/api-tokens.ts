/**
 * KUKAN API Token Routes
 * REST API endpoints for managing API tokens
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { UnauthorizedError } from '@kukan/shared'
import { ApiTokenService } from '../services/api-token-service'
import type { AppContext } from '../context'

const createTokenSchema = z.object({
  name: z.string().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

export const apiTokensRouter = new Hono<{ Variables: AppContext }>()

// POST /api/v1/api-tokens - Create a new API token
apiTokensRouter.post('/', zValidator('json', createTokenSchema), async (c) => {
  const user = c.get('user')
  if (!user) {
    throw new UnauthorizedError()
  }

  const db = c.get('db')
  const service = new ApiTokenService(db)
  const input = c.req.valid('json')

  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : undefined

  const result = await service.create(user.id, {
    name: input.name,
    expiresAt,
  })

  return c.json(result, 201)
})

// GET /api/v1/api-tokens - List current user's API tokens
apiTokensRouter.get('/', async (c) => {
  const user = c.get('user')
  if (!user) {
    throw new UnauthorizedError()
  }

  const db = c.get('db')
  const service = new ApiTokenService(db)

  const tokens = await service.listByUser(user.id)
  return c.json({ items: tokens })
})

// DELETE /api/v1/api-tokens/:id - Revoke an API token
apiTokensRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) {
    throw new UnauthorizedError()
  }

  const db = c.get('db')
  const service = new ApiTokenService(db)
  const tokenId = c.req.param('id')

  const result = await service.revoke(tokenId, user.id)
  return c.json(result)
})
