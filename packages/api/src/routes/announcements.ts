/**
 * KUKAN Announcements REST API Routes
 * /api/v1/announcements endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '../middleware/validator'
import { z } from 'zod'
import { AnnouncementService } from '../services/announcement-service'
import {
  createAnnouncementSchema,
  updateAnnouncementSchema,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '@kukan/shared'
import type { AppContext } from '../context'

export const announcementsRouter = new Hono<{ Variables: AppContext }>()

const idParam = z.object({ id: z.string().uuid() })

// GET /api/v1/announcements - List announcements
// Default: published only. sysadmin can pass publishedOnly=false to include drafts/scheduled.
announcementsRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      publishedOnly: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    })
  ),
  async (c) => {
    const params = c.req.valid('query')
    const user = c.get('user')
    const service = new AnnouncementService(c.get('db'))
    const publishedOnly = user?.sysadmin ? params.publishedOnly : true
    const result = await service.list({ ...params, publishedOnly })
    return c.json(result)
  }
)

// GET /api/v1/announcements/:id - Get announcement by ID
announcementsRouter.get('/:id', zValidator('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const service = new AnnouncementService(c.get('db'))
  const item = await service.getById(id)

  const user = c.get('user')
  if (!user?.sysadmin) {
    if (!item.publishedAt || item.publishedAt > new Date()) {
      throw new NotFoundError('Announcement', id)
    }
  }

  return c.json(item)
})

// POST /api/v1/announcements - Create announcement (sysadmin only)
announcementsRouter.post('/', zValidator('json', createAnnouncementSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can create announcements')

  const input = c.req.valid('json')
  const service = new AnnouncementService(c.get('db'))
  const created = await service.create(input)
  return c.json(created, 201)
})

// PUT /api/v1/announcements/:id - Update announcement (sysadmin only)
announcementsRouter.put(
  '/:id',
  zValidator('param', idParam),
  zValidator('json', updateAnnouncementSchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()
    if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can update announcements')

    const { id } = c.req.valid('param')
    const input = c.req.valid('json')
    const service = new AnnouncementService(c.get('db'))
    const updated = await service.update(id, input)
    return c.json(updated)
  }
)

// DELETE /api/v1/announcements/:id - Delete announcement (sysadmin only)
announcementsRouter.delete('/:id', zValidator('param', idParam), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can delete announcements')

  const { id } = c.req.valid('param')
  const service = new AnnouncementService(c.get('db'))
  const result = await service.delete(id)
  return c.json(result)
})
