/**
 * E2E: Responsive layout — public pages must not scroll horizontally at mobile widths.
 *
 * Seeds a dataset whose slug and metadata are long unbroken strings, the worst
 * case for horizontal overflow, then asserts scrollWidth === clientWidth on each
 * page and that no table is clipped behind an overflow-hidden ancestor, and that
 * no footer link is squeezed narrow enough to wrap.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import pg from 'pg'
import { createAdminRequest, seedOrganization, DB_URL } from './helpers'

const VIEWPORT_WIDTHS = [320, 390]

let adminRequest: APIRequestContext
let orgId: string
let datasetName: string
let resourceId: string

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
      // A long unbroken value makes the metadata table wider than a phone
      // viewport, so the table-reachability check below actually bites.
      extras: { checksum: 'c0ffee'.repeat(12) },
    },
  })
  if (!res.ok()) throw new Error(`Failed to create dataset: ${res.status()}`)
  const pkg = (await res.json()) as { id: string }

  // `.invalid` never resolves, so the enqueued run fails at Fetch and adds no
  // version of its own; the version below is seeded straight into the database
  // the same way resource-versions.e2e.ts does.
  const resRes = await adminRequest.post(`/api/v1/packages/${pkg.id}/resources`, {
    data: {
      url: 'https://e2e.invalid/responsive.csv',
      name: 'E2E responsive resource',
      format: 'CSV',
    },
  })
  if (!resRes.ok()) throw new Error(`Failed to create resource: ${resRes.status()}`)
  resourceId = ((await resRes.json()) as { id: string }).id

  const sha256 = `sha256:${'c0ffee'.repeat(11)}c0ffee7357`
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    await client.query(
      `INSERT INTO resource_version (resource_id, version, storage_key, size, hash, origin, format, state)
       VALUES ($1, 1, $2, 1234, $3, 'upload', 'CSV', 'active')`,
      [resourceId, `resources/e2e/${resourceId}.v1`, sha256]
    )
    // The unbroken hash makes the resource metadata table wider than a phone
    // viewport — the shape the reachability check exists for.
    await client.query(`UPDATE resource SET hash = $2 WHERE id = $1`, [resourceId, sha256])
  } finally {
    await client.end()
  }
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

async function expectNoHorizontalOverflow(
  page: Page,
  path: string,
  ready?: (page: Page) => Promise<void>
) {
  await page.goto(path)
  await expect(page.locator('main')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await ready?.(page)
  const { scrollWidth, clientWidth, unreachableTables } = await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => (d.open = true))
    // A table wider than its clipping ancestor must sit inside a horizontal
    // scroll container, or part of its content is unreachable on mobile.
    const unreachable: string[] = []
    for (const table of document.querySelectorAll('table')) {
      const tableWidth = table.getBoundingClientRect().width
      for (let el = table.parentElement; el; el = el.parentElement) {
        const overflowX = getComputedStyle(el).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') break
        if ((overflowX === 'hidden' || overflowX === 'clip') && tableWidth > el.clientWidth + 1) {
          unreachable.push(el.className)
          break
        }
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      unreachableTables: unreachable,
    }
  })
  expect(scrollWidth, `${path} must not scroll horizontally`).toBeLessThanOrEqual(clientWidth)
  expect(unreachableTables, `${path} must not clip tables behind overflow-hidden`).toEqual([])
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

    test('no horizontal overflow on the resource page', async ({ page }) => {
      await expectNoHorizontalOverflow(
        page,
        `/dataset/${datasetName}/resource/${resourceId}`,
        async () => {
          // The version history fetches on first open — open it for real (the
          // sweep's programmatic details.open skips React's onToggle fetch)
          // and wait for the seeded row so its table is present when measured.
          await page.getByText(/バージョン履歴|version history/i).click()
          await expect(page.getByRole('cell', { name: /^v1/ })).toBeVisible()
        }
      )
    })

    // Link labels are short enough to fit any phone; only a squeezed box wraps
    // them. The copyright sentence is long enough to wrap legitimately, so it is
    // out of scope here.
    test('footer links stay on a single line', async ({ page }) => {
      await page.goto('/')
      await page.waitForLoadState('networkidle')
      const { wrapped, checked } = await page.evaluate(async () => {
        // Text width depends on the swapped-in webfont, so measure after it lands
        await document.fonts.ready
        const range = document.createRange()
        const links = [...document.querySelectorAll('footer a')]
        // A range over the text yields one rect per line box it wraps onto; the
        // links' own rects would each be one box, since they are flex items.
        const wrapped = links.filter((el) => {
          range.selectNodeContents(el)
          return range.getClientRects().length > 1
        })
        return {
          wrapped: wrapped.map((el) => el.textContent?.trim()),
          checked: links.length,
        }
      })
      expect(checked, 'the footer must render links to measure').toBeGreaterThan(0)
      expect(wrapped, 'footer links must not wrap').toEqual([])
    })
  })
}
