/**
 * E2E test helpers — shared constants, data seeding, and cleanup.
 */

import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import pg from 'pg'

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
export const DB_URL = process.env.DATABASE_URL || 'postgresql://kukan:kukan@localhost:5432/kukan'
export const USER_FILE = 'apps/web/src/__tests__/.auth/user.json'
export const ADMIN_FILE = 'apps/web/src/__tests__/.auth/admin.json'
export const TEST_PASSWORD = 'e2e-password-12345678'

/** Create an API request context authenticated as the admin user */
export async function createAdminRequest() {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: ADMIN_FILE,
  })
}

/**
 * Remove all E2E test data (e2e-* prefix) from the database.
 * TODO: Replace with API-based cleanup (purge endpoints) to avoid direct DB access.
 */
export async function cleanupE2eData() {
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    // Application data (FK order: resource → package → organization)
    await client.query(`DELETE FROM resource WHERE name LIKE 'E2E%' OR name LIKE 'CRUD%'`)
    await client.query(`DELETE FROM package WHERE name LIKE 'e2e-%'`)
    await client.query(`DELETE FROM organization WHERE name LIKE 'e2e-%'`)
    // User data (cascade handles session/account, but activity/audit_log need explicit delete)
    const userIdSubquery = `SELECT id FROM "user" WHERE email LIKE 'e2e-%'`
    await client.query(`DELETE FROM activity WHERE user_id IN (${userIdSubquery})`)
    await client.query(`DELETE FROM session WHERE "userId" IN (${userIdSubquery})`)
    await client.query(`DELETE FROM account WHERE "userId" IN (${userIdSubquery})`)
    await client.query(`DELETE FROM "user" WHERE email LIKE 'e2e-%'`)
  } finally {
    await client.end()
  }
}

// --- Data seeding ---

export async function seedOrganization(request: APIRequestContext) {
  const name = `e2e-org-${Date.now()}`
  const res = await request.post('/api/v1/organizations', {
    data: { name, title: `E2E Org` },
  })
  if (!res.ok()) throw new Error(`Failed to create org: ${res.status()}`)
  return (await res.json()) as { id: string; name: string }
}

export async function seedDataset(request: APIRequestContext, orgId: string) {
  const name = `e2e-dataset-${Date.now()}`
  const res = await request.post('/api/v1/packages', {
    data: {
      name,
      title: `E2E Dataset`,
      notes: 'E2E test dataset',
      owner_org: orgId,
    },
  })
  if (!res.ok()) throw new Error(`Failed to create dataset: ${res.status()}`)
  return (await res.json()) as { id: string; name: string }
}

export async function seedResource(request: APIRequestContext, packageId: string) {
  const res = await request.post(`/api/v1/packages/${packageId}/resources`, {
    data: {
      url: 'https://example.com/data.csv',
      name: 'E2E test resource',
      format: 'CSV',
    },
  })
  if (!res.ok()) throw new Error(`Failed to create resource: ${res.status()}`)
  return (await res.json()) as { id: string; name: string; packageId: string }
}
