/**
 * The SQL the list endpoints emit, pinned.
 *
 * These queries count and aggregate related rows with correlated subqueries, and
 * several of them are still written as raw strings. Rewriting one to typed
 * references is not a refactor a type check can vouch for: drizzle drops the
 * table qualifier from a bare column placed directly in a select projection, so
 * `WHERE "package"."owner_org" = "organization"."id"` becomes `WHERE "owner_org"
 * = "id"` — a subquery that compares a row to itself, counts zero, and raises
 * nothing. Row-count assertions pass through it too, whenever the fixture's
 * expected count happens to be zero.
 *
 * So the shape itself is the thing under test. A rewrite that changes nothing
 * shows an empty diff here; one that uncorrelates a subquery shows the missing
 * qualifier in review.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { PackageService } from '../../services/package-service'
import {
  getTestDb,
  createQueryRecorder,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'

const db = getTestDb()
const { db: recorder, queries } = createQueryRecorder()

/** The viewer decides which branch of the member-count SQL is emitted. */
const outsider = {
  id: OUTSIDER_USER_ID,
  email: 'outsider@example.com',
  name: 'outsider',
  sysadmin: false,
}

const sysadminApp = createTestApp(recorder)
const memberApp = createTestApp(recorder, { user: outsider })
const anonymousApp = createTestApp(recorder, { user: null })

/** Rows to find, so each request takes the branch that reaches the database
 *  rather than an early return on an empty result. Seeded through the plain
 *  handle, which keeps the fixture's own statements off the recorder. */
beforeAll(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()

  const seedApp = createTestApp(db)
  await seedApp.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'shape-org', title: 'Shape Org' }),
  })
  await seedApp.request('/api/v1/organizations/shape-org/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
  })
  await seedApp.request('/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'shape-group', title: 'Shape Group' }),
  })
})

beforeEach(() => {
  queries.length = 0
})

afterAll(async () => {
  await closeTestDb()
})

/** The statements the recorder saw, asserted non-empty — a run that queried
 *  nothing would otherwise pin an empty list and pass forever. */
function recorded(): string[] {
  const emitted = queries.map((query) => query.trim())
  expect(emitted.length).toBeGreaterThan(0)
  return emitted
}

/** The statements one request emitted, in order. */
async function sqlFor(app: ReturnType<typeof createTestApp>, path: string): Promise<string[]> {
  const res = await app.request(path)
  expect(res.status).toBe(200)
  return recorded()
}

describe('emitted SQL shape', () => {
  describe('GET /api/v1/organizations', () => {
    it('pins the anonymous shape', async () => {
      expect(await sqlFor(anonymousApp, '/api/v1/organizations')).toMatchSnapshot()
    })

    it('pins the member shape', async () => {
      expect(await sqlFor(memberApp, '/api/v1/organizations')).toMatchSnapshot()
    })

    it('pins the sysadmin shape', async () => {
      expect(await sqlFor(sysadminApp, '/api/v1/organizations')).toMatchSnapshot()
    })

    it('pins the dataset-count ordering shape', async () => {
      expect(
        await sqlFor(anonymousApp, '/api/v1/organizations?orderBy=datasetCount')
      ).toMatchSnapshot()
    })
  })

  describe('GET /api/v1/groups', () => {
    it('pins the anonymous shape', async () => {
      expect(await sqlFor(anonymousApp, '/api/v1/groups')).toMatchSnapshot()
    })

    it('pins the member shape', async () => {
      expect(await sqlFor(memberApp, '/api/v1/groups')).toMatchSnapshot()
    })

    it('pins the sysadmin shape', async () => {
      expect(await sqlFor(sysadminApp, '/api/v1/groups')).toMatchSnapshot()
    })
  })

  // Driven through the service: the route asks the search adapter first, and
  // the stub answers with no matches, which short-circuits the list before it
  // reaches the database (packages/api/src/services/package-service.ts).
  describe('PackageService.list', () => {
    it('pins the list shape', async () => {
      await new PackageService(recorder).list({ limit: 20 })
      expect(recorded()).toMatchSnapshot()
    })
  })

  describe('GET /api/v1/users/me/organizations', () => {
    it('pins the sysadmin shape', async () => {
      expect(await sqlFor(sysadminApp, '/api/v1/users/me/organizations')).toMatchSnapshot()
    })

    it('pins the member shape', async () => {
      expect(await sqlFor(memberApp, '/api/v1/users/me/organizations')).toMatchSnapshot()
    })
  })
})
