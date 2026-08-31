/**
 * E2E: Responsive layout — public pages must not scroll horizontally at mobile widths.
 *
 * Seeds a dataset whose slug is a long unbroken string, the worst case for
 * horizontal overflow, then asserts scrollWidth === clientWidth on each page.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAdminRequest, seedOrganization } from './helpers'

const VIEWPORT_WIDTHS = [320, 390]

let adminRequest: APIRequestContext
let orgId: string
let datasetName: string

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id
  datasetName = `e2e-responsive-${Date.now()}-danjyobetunenreibetujinkoutoukeichousa`
  const res = await adminRequest.post('/api/v1/packages', {
    data: {
      name: datasetName,
      title: 'E2E レスポンシブ検証用の年齢別・男女別人口統計調査データセット',
      notes: 'E2E responsive layout test dataset',
      ownerOrg: orgId,
    },
  })
  if (!res.ok()) throw new Error(`Failed to create dataset: ${res.status()}`)
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

async function expectNoHorizontalOverflow(page: Page, path: string) {
  await page.goto(path)
  await expect(page.locator('main')).toBeVisible()
  await page.waitForLoadState('networkidle')
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, `${path} must not scroll horizontally`).toBeLessThanOrEqual(clientWidth)
}

for (const width of VIEWPORT_WIDTHS) {
  test.describe(`Responsive layout at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } })

    for (const path of ['/', '/dataset', '/organization', '/group']) {
      test(`no horizontal overflow on ${path}`, async ({ page }) => {
        await expectNoHorizontalOverflow(page, path)
      })
    }

    test('no horizontal overflow on the dataset detail page', async ({ page }) => {
      await expectNoHorizontalOverflow(page, `/dataset/${datasetName}`)
    })
  })
}
