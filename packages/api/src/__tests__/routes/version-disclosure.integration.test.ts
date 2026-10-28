import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import rootPackage from '../../../../../package.json'

/**
 * Nothing an anonymous caller can reach names the release (ADR-070): a
 * vulnerability assessment reports it, and once a flaw is published it points
 * at the sites still running the release that has it. The product name is
 * fine; the version is the part this guards.
 */

const db = getTestDb()
const search = new PostgresSearchAdapter(db)
const app = createTestApp(db, { search })
const anonymous = createTestApp(db, { search, user: null })
const { version } = rootPackage

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const org = await (
    await app.request('/api/v1/organizations', json({ name: 'version-org' }))
  ).json()
  const pkg = await (
    await app.request('/api/v1/packages', json({ name: 'version-pkg', ownerOrg: org.id }))
  ).json()
  await app.request(
    `/api/v1/packages/${pkg.id}/resources`,
    json({ name: 'data', url: 'https://example.com/data.csv', format: 'CSV' })
  )
})

afterAll(async () => {
  await closeTestDb()
})

const REQUESTS: [label: string, path: string, init?: RequestInit][] = [
  ['health check', '/api/health'],
  ['site settings', '/api/v1/site/settings'],
  ['dataset list', '/api/v1/packages'],
  ['dataset detail', '/api/v1/packages/version-pkg'],
  ['organization list', '/api/v1/organizations'],
  ['CKAN package_list', '/api/3/action/package_list'],
  ['CKAN package_show', '/api/3/action/package_show?id=version-pkg'],
  ['CKAN package_search', '/api/3/action/package_search'],
  ['CKAN organization_list', '/api/3/action/organization_list'],
  ['CKAN license_list', '/api/3/action/license_list'],
  ['CKAN help_show', '/api/3/action/help_show?name=package_show'],
  ['CKAN status_show, which KUKAN does not answer', '/api/3/action/status_show'],
  ['CKAN malformed body', '/api/3/action/package_show', json('{')],
  ['sitemap', '/internal/sitemap'],
  ['admin route without a session', '/api/v1/admin/settings'],
  ['unknown path', '/api/v1/no-such-route'],
  ['malformed id', '/api/v1/packages/00000000-0000-0000-0000-00000000000z'],
  [
    'MCP initialize',
    '/api/mcp',
    json({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1' },
      },
    }),
  ],
]

describe('version disclosure to anonymous callers', () => {
  it.each(REQUESTS)('%s names no release in its headers or body', async (_label, path, init) => {
    const res = await anonymous.request(path, init)
    const headers = [...res.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
    expect(headers).not.toContain(version)
    expect(await res.text()).not.toContain(version)
  })

  it('reads the dataset the sweep looks through, so the bodies above are not empty refusals', async () => {
    const res = await anonymous.request('/api/3/action/package_show?id=version-pkg')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.resources).toHaveLength(1)
  })

  it('does not answer status_show, where CKAN reports its version', async () => {
    const res = await anonymous.request('/api/3/action/status_show')
    expect(res.status).toBe(400)
  })
})
