import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { packageTable, resource } from '@kukan/db'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { pagedField, rankedId } from '../test-helpers/paging'

const db = getTestDb()
const app = createTestApp(db)
const unauthApp = createTestApp(db, { user: null })
const nonAdminApp = createTestApp(db, {
  user: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'regular@example.com',
    name: 'regular-user',
    sysadmin: false,
  },
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

/** Create org → package → URL resource, return resource ID */
async function createUrlResource(name: string, healthStatus = 'unknown') {
  // Create org
  const orgRes = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `org-${name}`, title: `Org ${name}` }),
  })
  const org = await orgRes.json()

  // Create package
  const pkgRes = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `pkg-${name}`, title: `Package ${name}`, ownerOrg: org.id }),
  })
  const pkg = await pkgRes.json()

  // Create resource (URL type — urlType will be null)
  const resRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `resource-${name}`,
      url: `https://example.com/${name}.csv`,
      format: 'CSV',
    }),
  })
  const res = await resRes.json()

  // Update healthStatus directly in DB
  if (healthStatus !== 'unknown') {
    await db
      .update(resource)
      .set({ healthStatus, healthCheckedAt: new Date() })
      .where(eq(resource.id, res.id))
  }

  return res.id as string
}

describe('Admin Health API Routes', () => {
  describe('GET /api/v1/admin/health/stats', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/health/stats')
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/health/stats')
      expect(res.status).toBe(403)
    })

    it('should return empty stats when no URL resources', async () => {
      const res = await app.request('/api/v1/admin/health/stats')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({})
    })

    it('should return status counts grouped by healthStatus', async () => {
      await createUrlResource('a', 'ok')
      await createUrlResource('b', 'ok')
      await createUrlResource('c', 'error')
      await createUrlResource('d') // unknown

      const res = await app.request('/api/v1/admin/health/stats')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.ok).toBe(2)
      expect(body.error).toBe(1)
      expect(body.unknown).toBe(1)
    })
  })

  describe('GET /api/v1/admin/health', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/health')
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/health')
      expect(res.status).toBe(403)
    })

    it('should return paginated URL resource list', async () => {
      await createUrlResource('a', 'ok')
      await createUrlResource('b', 'error')

      const res = await app.request('/api/v1/admin/health')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.total).toBe(2)
      expect(body.items).toHaveLength(2)
      expect(body.offset).toBe(0)
      expect(body.limit).toBe(20)

      // Error should come first (sort order)
      expect(body.items[0].healthStatus).toBe('error')
      expect(body.items[1].healthStatus).toBe('ok')

      // Each item should have package info
      expect(body.items[0].packageName).toBeDefined()
      expect(body.items[0].url).toContain('https://example.com/')
    })

    it('should filter by status', async () => {
      await createUrlResource('a', 'ok')
      await createUrlResource('b', 'error')
      await createUrlResource('c', 'ok')

      const res = await app.request('/api/v1/admin/health?status=error')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.total).toBe(1)
      expect(body.items).toHaveLength(1)
      expect(body.items[0].healthStatus).toBe('error')
    })

    it('should respect pagination', async () => {
      await createUrlResource('a', 'ok')
      await createUrlResource('b', 'ok')
      await createUrlResource('c', 'ok')

      const res = await app.request('/api/v1/admin/health?limit=2&offset=0')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.total).toBe(3)
      expect(body.items).toHaveLength(2)

      const res2 = await app.request('/api/v1/admin/health?limit=2&offset=2')
      const body2 = await res2.json()

      expect(body2.total).toBe(3)
      expect(body2.items).toHaveLength(1)
    })

    it('pages resources never checked without repeating or skipping one', async () => {
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'health-tie-pkg', state: 'active' })
        .returning({ id: packageTable.id })
      // All unknown and unchecked, so they tie on status and on the null time
      for (const i of [0, 1, 2, 3]) {
        await db.insert(resource).values({
          id: rankedId(i + 1), // see test-helpers/paging
          packageId: pkg.id,
          name: `tie-${i}`,
          state: 'active',
          url: `https://example.com/tie-${i}.csv`,
        })
      }

      expect(await pagedField(app, '/api/v1/admin/health', 'name', 3)).toEqual([
        'tie-3',
        'tie-2',
        'tie-1',
        'tie-0',
      ])
    })

    it('should exclude upload resources', async () => {
      await createUrlResource('url-res', 'ok')

      // Create an upload resource via upload-url endpoint
      const orgRes = await app.request('/api/v1/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'org-upload', title: 'Upload Org' }),
      })
      const org = await orgRes.json()
      const pkgRes = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-upload', title: 'Upload Pkg', ownerOrg: org.id }),
      })
      const pkg = await pkgRes.json()
      const resRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'upload-file', url: 'file.csv', format: 'CSV' }),
      })
      const uploadRes = await resRes.json()

      // Manually set urlType to 'upload' to simulate uploaded file
      await db.update(resource).set({ urlType: 'upload' }).where(eq(resource.id, uploadRes.id))

      const res = await app.request('/api/v1/admin/health')
      expect(res.status).toBe(200)
      const body = await res.json()

      // Only the URL resource should appear
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('resource-url-res')
    })
  })
})
