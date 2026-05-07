/**
 * E2E test helpers — shared constants, data seeding, and cleanup.
 */

import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'

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
 * Remove all E2E test data (e2e-* prefix) via API.
 * Requires an authenticated admin request context.
 * Order: packages (CASCADE deletes resources) → organizations → users
 */
export async function cleanupE2eData(request: APIRequestContext) {
  // Best-effort cleanup of active e2e data via API.
  // Deleted data that is not listed by the API is handled by individual afterAll hooks.

  // Packages: purge deleted, then soft-delete active and purge
  for (const state of ['deleted', 'active'] as const) {
    const url = `/api/v1/packages?my_org=true&state=${state}&limit=100`
    const pkgRes = await request.get(url)
    if (!pkgRes.ok()) continue
    const { items } = await pkgRes.json()
    for (const pkg of items) {
      if (typeof pkg.name === 'string' && pkg.name.startsWith('e2e-')) {
        if (state === 'active') {
          await request.delete(`/api/v1/packages/${pkg.name}`).catch(() => {})
        }
        await request.post(`/api/v1/packages/${pkg.name}/purge`).catch(() => {})
      }
    }
  }

  // Organizations: soft-delete then purge
  const orgRes = await request.get('/api/v1/organizations?limit=100')
  if (orgRes.ok()) {
    const { items } = await orgRes.json()
    for (const org of items) {
      if (typeof org.name === 'string' && org.name.startsWith('e2e-')) {
        await request.delete(`/api/v1/organizations/${org.name}`).catch(() => {})
        await request.post(`/api/v1/organizations/${org.name}/purge`).catch(() => {})
      }
    }
  }

  // Users: soft-delete then purge
  const userRes = await request.get('/api/v1/admin/users?q=e2e-&limit=100')
  if (userRes.ok()) {
    const { items } = await userRes.json()
    for (const u of items) {
      if (typeof u.email === 'string' && u.email.startsWith('e2e-')) {
        if (u.state === 'active') {
          await request.delete(`/api/v1/admin/users/${u.id}`).catch(() => {})
        }
        await request.post(`/api/v1/admin/users/${u.id}/purge`).catch(() => {})
      }
    }
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
