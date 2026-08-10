/**
 * E2E: Resource version history, diff and purge (ADR-043).
 *
 * The history is the one screen where a legal deletion is started, so what it
 * says about a version has to survive a refactor. ii-b changes this UI, and
 * these are the claims it must not quietly drop.
 *
 * Versions are seeded straight into the database rather than produced by a
 * pipeline run: creating one takes a fetch, an interpretation and a lake
 * ingest, none of which is under test here, and all of which make the run slow
 * and its timing a variable. `auth.setup.ts` reaches for the database the same
 * way.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import pg from 'pg'
import { createAdminRequest, seedOrganization, ADMIN_FILE, DB_URL } from './helpers'

test.use({ storageState: ADMIN_FILE })

let adminRequest: APIRequestContext
let orgId: string
let resourceId: string
const datasetName = `e2e-versions-${Date.now()}`
const resourceName = 'E2E versioned resource'

/** v1 and v2 hold the same bytes; v3 holds its own. */
const SHARED_HASH = 'sha256:e2e-shared-content'

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Open the resource's inline editor, which is where the history lives. */
async function openHistory(page: Page) {
  await page.goto(`/dashboard/datasets/${datasetName}/edit`)
  await page.getByRole('button', { name: new RegExp(resourceName) }).click()
  await expect(page.getByText(/version history|バージョン履歴/i)).toBeVisible({ timeout: 10_000 })
}

/**
 * The history's own table.
 *
 * Scoped by a column only it has, because the resource list is a table too and
 * shows each resource's latest version number — an unscoped `v3` matches there.
 * Then `last()`, because the editor opens *inside* a row of that outer table,
 * so the filter matches the outer one as well: it contains this one.
 */
function historyTable(page: Page) {
  return page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: /origin|取得元/i }) })
    .last()
}

function versionRow(page: Page, version: number) {
  return historyTable(page).getByRole('row', { name: new RegExp(`v${version}\\b`) })
}

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id

  const pkgRes = await adminRequest.post('/api/v1/packages', {
    data: { name: datasetName, title: 'E2E Versions', ownerOrg: orgId },
  })
  const pkg = await pkgRes.json()

  const resRes = await adminRequest.post(`/api/v1/packages/${pkg.id}/resources`, {
    // `.invalid` never resolves, so the run this create enqueues fails at Fetch
    // and adds no version of its own — the history holds exactly what is seeded
    // below. A reachable URL made the worker file a fourth one, and which
    // assertions saw it depended on how fast it got there.
    data: { url: 'https://e2e.invalid/versions.csv', name: resourceName, format: 'CSV' },
  })
  resourceId = (await resRes.json()).id

  await withDb((client) =>
    client.query(
      `INSERT INTO resource_version
         (resource_id, version, storage_key, size, hash, origin, format, state)
       VALUES ($1, 1, $2, 10, $5, 'upload', 'CSV', 'active'),
              ($1, 2, $3, 20, $5, 'upload', 'CSV', 'active'),
              ($1, 3, $4, 30, 'sha256:e2e-its-own', 'fetch', 'CSV', 'active')`,
      [
        resourceId,
        `resources/e2e/${resourceId}.v1`,
        `resources/e2e/${resourceId}.v2`,
        `resources/e2e/${resourceId}.v3`,
        SHARED_HASH,
      ]
    )
  )
})

test.afterAll(async () => {
  if (!adminRequest) return
  await adminRequest.delete(`/api/v1/packages/${datasetName}`).catch(() => {})
  await adminRequest.post(`/api/v1/packages/${datasetName}/purge`).catch(() => {})
  if (orgId) {
    await adminRequest.delete(`/api/v1/organizations/${orgId}`).catch(() => {})
    await adminRequest.post(`/api/v1/organizations/${orgId}/purge`).catch(() => {})
  }
  await adminRequest.dispose()
})

test.describe('Resource versions', () => {
  test.describe.configure({ mode: 'serial' })

  test('lists every version, newest first', async ({ page }) => {
    await openHistory(page)

    const rows = historyTable(page).getByRole('row', { name: /v\d/ })
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText('v3')
    await expect(rows.last()).toContainText('v1')
  })

  test('says why a diff is unavailable rather than failing', async ({ page }) => {
    // Nothing reached DuckLake, so the panel has to explain itself. Silence
    // here reads as a broken screen.
    await openHistory(page)
    await versionRow(page, 3)
      .getByRole('button', { name: /^(diff|差分)$/i })
      .click()

    await expect(page.getByText(/not covered by diffs|差分の対象外/i)).toBeVisible({
      timeout: 10_000,
    })
  })

  test('names the versions a purge would leave holding the same content', async ({ page }) => {
    // v1 holds the same bytes as v2 and keeps serving them; v3 does not.
    // Purging v2 without saying so tells someone erasing personal data that it
    // is gone when it is not.
    await openHistory(page)
    await versionRow(page, 2)
      .getByRole('button', { name: /purge|完全削除/i })
      .click()

    const warning = page.getByRole('alert')
    await expect(warning).toContainText('v1')
    await expect(warning).not.toContainText('v3')
  })

  test('says nothing about other versions when the content is this one’s alone', async ({
    page,
  }) => {
    await openHistory(page)
    await versionRow(page, 3)
      .getByRole('button', { name: /purge|完全削除/i })
      .click()

    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
