/**
 * E2E: Dataset CRUD
 * Uses admin storageState for API operations (org/package creation requires sysadmin).
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { createAdminRequest, seedOrganization, ADMIN_FILE } from './helpers'

test.use({ storageState: ADMIN_FILE })

let adminRequest: APIRequestContext
let orgId: string

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id
})

test.afterAll(async () => {
  if (!adminRequest) return
  if (orgId) await adminRequest.delete(`/api/v1/organizations/${orgId}`).catch(() => {})
  await adminRequest.dispose()
})

test.describe('Dataset CRUD', () => {
  test.describe.configure({ mode: 'serial' })
  const datasetName = `e2e-crud-${Date.now()}`

  test('create dataset via API and view it', async ({ page, request }) => {
    const res = await request.post('/api/v1/packages', {
      data: {
        name: datasetName,
        title: 'E2E CRUD Test Dataset',
        notes: 'Created by E2E test',
        owner_org: orgId,
      },
    })
    expect(res.ok()).toBe(true)

    await page.goto(`/dataset/${datasetName}`)
    await expect(page.locator('main')).toContainText('E2E CRUD Test Dataset')
  })

  test('edit dataset title via API and verify', async ({ page, request }) => {
    const res = await request.patch(`/api/v1/packages/${datasetName}`, {
      data: { title: 'E2E CRUD Updated Title' },
    })
    expect(res.ok()).toBe(true)

    await page.goto(`/dataset/${datasetName}`)
    await expect(page.locator('main')).toContainText('E2E CRUD Updated Title')
  })

  test('add resource and verify on detail page', async ({ page, request }) => {
    const pkgRes = await request.get(`/api/v1/packages/${datasetName}`)
    const pkg = await pkgRes.json()

    const res = await request.post(`/api/v1/packages/${pkg.id}/resources`, {
      data: {
        url: 'https://example.com/crud-test.csv',
        name: 'CRUD test resource',
        format: 'CSV',
      },
    })
    expect(res.ok()).toBe(true)

    await page.goto(`/dataset/${datasetName}`)
    await expect(page.locator('main')).toContainText('CRUD test resource')
  })

  test('delete dataset via API', async ({ request }) => {
    const res = await request.delete(`/api/v1/packages/${datasetName}`)
    expect(res.ok()).toBe(true)

    const body = await res.json()
    expect(body.state).toBe('deleted')
  })
})
