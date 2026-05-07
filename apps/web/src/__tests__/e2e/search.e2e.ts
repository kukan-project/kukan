/**
 * E2E: Search flow
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { createAdminRequest, seedOrganization, seedDataset, seedResource } from './helpers'

let adminRequest: APIRequestContext
let orgId: string
let datasetName: string
let resourceId: string

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id
  const dataset = await seedDataset(adminRequest, orgId)
  datasetName = dataset.name
  const resource = await seedResource(adminRequest, dataset.id)
  resourceId = resource.id
})

test.afterAll(async () => {
  if (!adminRequest) return
  if (datasetName) {
    await adminRequest.delete(`/api/v1/packages/${datasetName}`).catch(() => {})
    await adminRequest.post(`/api/v1/packages/${datasetName}/purge`).catch(() => {})
  }
  if (orgId) {
    await adminRequest.delete(`/api/v1/organizations/${orgId}`).catch(() => {})
    await adminRequest.post(`/api/v1/organizations/${orgId}/purge`).catch(() => {})
  }
  await adminRequest.dispose()
})

test.describe('Search', () => {
  test('dataset listing page loads', async ({ page }) => {
    await page.goto('/dataset')
    await expect(page.locator('main')).toBeVisible()
  })

  test('search by keyword shows results', async ({ page }) => {
    await page.goto('/dataset')
    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="検索"], input[placeholder*="earch"]'
    )
    await searchInput.fill('E2E Dataset')
    await searchInput.press('Enter')

    await expect(page.locator('main')).toContainText('E2E Dataset', { timeout: 10_000 })
  })

  test('click dataset navigates to detail page', async ({ page }) => {
    await page.goto(`/dataset/${datasetName}`)

    await expect(page.locator('main')).toContainText('E2E Dataset')
    await expect(page.locator('main')).toContainText('E2E test resource')
  })

  test('click resource navigates to resource detail', async ({ page }) => {
    await page.goto(`/dataset/${datasetName}/resource/${resourceId}`)

    await expect(page.locator('main')).toContainText('E2E test resource')
    await expect(page.locator('main')).toContainText('CSV')
  })
})
