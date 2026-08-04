/**
 * KUKAN Users REST API Routes
 * /api/v1/users endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '../middleware/validator'
import { z } from 'zod'
import { eq, and, sql, ilike, or, getTableColumns } from 'drizzle-orm'
import { organization, userOrgMembership, group, userGroupMembership, user } from '@kukan/db'
import { escapeLike, UnauthorizedError } from '@kukan/shared'
import type { AppContext } from '../context'

export const usersRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/users/me - Get current user info
usersRouter.get('/me', async (c) => {
  const currentUser = c.get('user')

  if (!currentUser) {
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

  // Fetch from DB to include displayName and other fields not in session
  const db = c.get('db')
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      displayName: user.displayName,
      sysadmin: sql<boolean>`(${user.role} = 'sysadmin')`.as('sysadmin'),
    })
    .from(user)
    .where(eq(user.id, currentUser.id))
    .limit(1)

  if (!row) {
    return c.json(
      { type: 'about:blank', title: 'Not Found', status: 404, detail: 'User not found' },
      404
    )
  }

  return c.json(row)
})

// GET /api/v1/users/me/organizations - Get organizations the current user belongs to
usersRouter.get('/me/organizations', async (c) => {
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

  const db = c.get('db')

  const datasetCountSql =
    sql<number>`(SELECT COUNT(*)::int FROM "package" WHERE "package"."owner_org" = "organization"."id" AND "package"."state" = 'active')`.as(
      'dataset_count'
    )

  if (user.sysadmin) {
    // Sysadmin sees all active organizations
    const rows = await db
      .select({
        ...getTableColumns(organization),
        role: sql<string>`'admin'`.as('role'),
        datasetCount: datasetCountSql,
      })
      .from(organization)
      .where(eq(organization.state, 'active'))

    return c.json({ items: rows })
  }

  // Regular user: organizations they belong to
  const rows = await db
    .select({
      ...getTableColumns(organization),
      role: userOrgMembership.role,
      datasetCount: datasetCountSql,
    })
    .from(userOrgMembership)
    .innerJoin(
      organization,
      and(eq(userOrgMembership.organizationId, organization.id), eq(organization.state, 'active'))
    )
    .where(eq(userOrgMembership.userId, user.id))

  return c.json({ items: rows })
})

// GET /api/v1/users/me/groups - Get groups the current user belongs to.
// The groups list itself is publicly cached, so per-viewer roles have to come
// from here instead of being mixed into that response. Identity and role only:
// the dashboard reads its counts and titles from the group list.
usersRouter.get('/me/groups', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')

  if (user.sysadmin) {
    // Sysadmins manage every group, so they come back as admin everywhere
    const rows = await db
      .select({
        id: group.id,
        name: group.name,
        role: sql<string>`'admin'`.as('role'),
      })
      .from(group)
      .where(eq(group.state, 'active'))

    return c.json({ items: rows })
  }

  const rows = await db
    .select({
      id: group.id,
      name: group.name,
      role: userGroupMembership.role,
    })
    .from(userGroupMembership)
    .innerJoin(group, and(eq(userGroupMembership.groupId, group.id), eq(group.state, 'active')))
    .where(eq(userGroupMembership.userId, user.id))

  return c.json({ items: rows })
})

// GET /api/v1/users - Search users (for member management)
usersRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      q: z.string().min(1),
      limit: z.coerce.number().min(1).max(50).default(10),
    })
  ),
  async (c) => {
    const currentUser = c.get('user')
    if (!currentUser) {
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

    const db = c.get('db')
    const { q, limit } = c.req.valid('query')
    const pattern = `%${escapeLike(q)}%`

    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        displayName: user.displayName,
      })
      .from(user)
      .where(
        and(eq(user.state, 'active'), or(ilike(user.name, pattern), ilike(user.email, pattern)))
      )
      .limit(limit)

    return c.json({ items: rows })
  }
)
