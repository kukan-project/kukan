/**
 * E2E: the pages' Content-Security-Policy (ADR-071).
 *
 * Under `report-only` nothing is blocked, but the browser still fires a
 * `securitypolicyviolation` event for what the policy would block — so a run
 * that passes here says enforcing the policy would break nothing on these
 * pages. The dev server is what `pnpm test:e2e` starts, so `'unsafe-eval'` is
 * in the policy and Fast Refresh is not a violation.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  ADMIN_FILE,
  createAdminRequest,
  seedOrganization,
  seedDataset,
  seedResource,
} from './helpers'

interface Violation {
  effectiveDirective: string
  blockedURI: string
  sourceFile: string
  disposition: string
}

declare global {
  interface Window {
    __cspViolations?: Violation[]
  }
}

let adminRequest: APIRequestContext
let orgId: string
let orgName: string
let datasetName: string
let resourceId: string

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id
  orgName = org.name
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

test.beforeEach(async ({ page }) => {
  // Before any of the page's own scripts: a violation during hydration counts too
  await page.addInitScript(() => {
    window.__cspViolations = []
    window.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations!.push({
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        disposition: event.disposition,
      })
    })
  })
})

async function violationsOn(page: Page, path: string): Promise<Violation[]> {
  const response = await page.goto(path)
  expect(response, path).not.toBeNull()
  // Signed in as the regular user: a dashboard page that sent us to sign in would pass as quiet
  expect(page.url(), `${path} is the page checked`).toContain(path)
  const headers = response!.headers()
  // Either mode carries the full policy on the document
  const policy =
    headers['content-security-policy-report-only'] ?? headers['content-security-policy']
  expect(policy, `${path} carries the policy`).toContain("default-src 'self'")
  expect(headers['content-security-policy'], `${path} enforces frame-src`).toContain('frame-src ')
  await expect(page.locator('main')).toBeVisible()
  // Lazy work — the preview, the map tiles, the DuckDB worker — reports after load
  await page.waitForLoadState('networkidle')
  return page.evaluate(() => window.__cspViolations ?? [])
}

test.describe('Content-Security-Policy', () => {
  test('public pages load without a violation', async ({ page }) => {
    for (const path of [
      '/',
      '/dataset',
      '/dataset?q=E2E',
      `/dataset/${datasetName}`,
      `/dataset/${datasetName}/resource/${resourceId}`,
      `/organization/${orgName}`,
      '/organization',
      '/group',
    ]) {
      expect(await violationsOn(page, path), path).toEqual([])
    }
  })

  test('dashboard pages load without a violation', async ({ page }) => {
    for (const path of ['/dashboard', '/dashboard/datasets']) {
      expect(await violationsOn(page, path), path).toEqual([])
    }
  })

  test('client-side navigation keeps the arrival page’s policy quiet', async ({ page }) => {
    expect(await violationsOn(page, '/dataset')).toEqual([])
    await page.getByRole('link', { name: 'E2E Dataset' }).first().click()
    await expect(page.locator('main')).toContainText('E2E test resource')
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([])
  })
})

// The one request a page makes to another origin: the upload's PUT to the
// storage endpoint (`connect-src`), which only the browser can exercise
test.describe('Content-Security-Policy: upload', () => {
  test.use({ storageState: ADMIN_FILE })

  test('a file dropped on the dashboard reaches storage without a violation', async ({ page }) => {
    test.setTimeout(90_000)
    expect(await violationsOn(page, `/dashboard/datasets/${datasetName}/edit`)).toEqual([])
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'e2e-csp.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('a,b\n1,2\n'),
    })
    // Done when the file is a row of the resource list (a reorder button,
    // not a table row) whose source reads as the upload — the zone's own
    // "complete" message is gone by then
    await expect(
      page.getByRole('button', { name: /e2e-csp\.csv.*(Upload|アップロード)/ })
    ).toBeVisible({ timeout: 45_000 })
    expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([])
  })
})
