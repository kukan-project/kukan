/**
 * KUKAN Users REST API Routes
 * /api/v1/users endpoints
 */

import { Hono } from 'hono'
import type { AppContext } from '../context'

export const usersRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/users/me - Get current user info
usersRouter.get('/me', async (c) => {
  const user = c.get('user')

  if (!user) {
    return c.json(
      {
        type: 'about:blank',
        title: 'UNAUTHORIZED',
        status: 401,
        detail: 'Authentication required',
      },
      401
    )
  }

  return c.json(user)
})
