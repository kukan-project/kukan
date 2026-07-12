/**
 * E2E: Dataset draft lifecycle (ADR-039)
 * Create as draft → publish preconditions → publish → immediate draft purge.
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { createAdminRequest, seedOrganization, ADMIN_FILE } from './helpers'

test.use({ storageState: ADMIN_FILE })

let adminRequest: APIRequestContext
let orgId: string
let draftId: string
const datasetName = `e2e-draft-${Date.now()}`

test.beforeAll(async () => {
  adminRequest = await createAdminRequest()
  const org = await seedOrganization(adminRequest)
  orgId = org.id
})

test.afterAll(async () => {
  if (!adminRequest) return
  // Published dataset: soft-delete then purge; unpublished draft: DELETE purges directly
  await adminRequest.delete(`/api/v1/packages/${datasetName}`).catch(() => {})
  await adminRequest.post(`/api/v1/packages/${datasetName}/purge`).catch(() => {})
  if (draftId) await adminRequest.delete(`/api/v1/packages/${draftId}`).catch(() => {})
  if (orgId) {
    await adminRequest.delete(`/api/v1/organizations/${orgId}`).catch(() => {})
    await adminRequest.post(`/api/v1/organizations/${orgId}/purge`).catch(() => {})
  }
  await adminRequest.dispose()
})

test.describe('Dataset draft lifecycle', () => {
  test.describe.configure({ mode: 'serial' })

  test('create a draft from the new dataset form', async ({ page }) => {
    await page.goto('/dashboard/datasets/new')

    await page.getByLabel(/^タイトル$|^Title$/).fill('E2E Draft Dataset')
    await page.getByRole('button', { name: /下書きを作成|Create Draft/ }).click()

    // The form creates a draft and lands on its edit page (UUID, not the placeholder name)
    await page.waitForURL(/\/dashboard\/datasets\/[0-9a-f-]{36}\/edit\?state=draft/)
    draftId = page.url().match(/datasets\/([0-9a-f-]{36})\/edit/)![1]

    await expect(page.locator('main')).toContainText(/下書き|Draft/)
  })

  test('draft has a placeholder name and stays out of the active listing', async ({ request }) => {
    const res = await request.get(`/api/v1/packages/${draftId}?state=draft`)
    expect(res.ok()).toBe(true)
    const pkg = await res.json()
    expect(pkg.state).toBe('draft')
    expect(pkg.name).toMatch(/^untitled-[0-9a-f]{8}$/)
    expect(pkg.ownerOrg).toBeNull()

    // Invisible through the default (active) detail path
    const activeRes = await request.get(`/api/v1/packages/${draftId}`)
    expect(activeRes.status()).toBe(404)
  })

  test('draft appears in the dashboard drafts tab', async ({ page }) => {
    await page.goto('/dashboard/datasets')
    await page
      .getByText(/^下書き$|^Drafts$/)
      .first()
      .click()

    await expect(page.locator('main')).toContainText('E2E Draft Dataset')
    // The auto-generated placeholder name is never shown
    await expect(page.locator('main')).not.toContainText(/untitled-[0-9a-f]{8}/)
  })

  test('publish is blocked until name, organization and license are set', async ({
    page,
    request,
  }) => {
    await page.goto(`/dashboard/datasets/${draftId}/edit?state=draft`)
    const publishButton = page.getByRole('button', { name: /保存して公開|Save & Publish/ })
    await expect(publishButton).toBeDisabled()
    // The button explains itself with the live-value precondition hints
    await expect(page.locator('main')).toContainText(
      /公開するにはURL識別子を入力してください|Enter a URL identifier to publish/
    )

    // Server enforces the same preconditions
    const res = await request.post(`/api/v1/packages/${draftId}/publish`)
    expect(res.status()).toBe(400)
  })

  test('publish succeeds after setting name, organization and license', async ({
    page,
    request,
  }) => {
    const putRes = await request.put(`/api/v1/packages/${draftId}`, {
      data: { name: datasetName, ownerOrg: orgId, licenseId: 'cc-by' },
    })
    expect(putRes.ok()).toBe(true)

    await page.goto(`/dashboard/datasets/${draftId}/edit?state=draft`)
    // Save & Publish saves the form (PUT) and then publishes in one step
    const publishButton = page.getByRole('button', { name: /保存して公開|Save & Publish/ })
    await expect(publishButton).toBeEnabled()
    await publishButton.click()

    await expect(page.locator('main')).toContainText(/公開しました|published/i)

    const res = await request.get(`/api/v1/packages/${datasetName}`)
    expect(res.ok()).toBe(true)
    expect((await res.json()).state).toBe('active')
  })

  test('published dataset is visible on its public page', async ({ page }) => {
    await page.goto(`/dataset/${datasetName}`)
    await expect(page.locator('main')).toContainText('E2E Draft Dataset')
  })

  test('clearing the name resets it to a placeholder and blocks publish', async ({
    page,
    request,
  }) => {
    const createRes = await request.post('/api/v1/packages/drafts', {
      data: { title: 'E2E Draft Name Reset', name: `e2e-name-reset-${Date.now()}` },
    })
    expect(createRes.status()).toBe(201)
    const draft = await createRes.json()

    try {
      await page.goto(`/dashboard/datasets/${draft.id}/edit?state=draft`)
      const nameInput = page.getByLabel(/URL識別子|URL Identifier/)
      await expect(nameInput).toHaveValue(draft.name)
      await nameInput.fill('')
      await page.getByRole('button', { name: /下書きを保存|Save Draft/ }).click()

      // Saving a cleared name sends name: null — the server regenerates the placeholder
      await expect
        .poll(async () => {
          const res = await request.get(`/api/v1/packages/${draft.id}?state=draft`)
          return (await res.json()).name
        })
        .toMatch(/^untitled-[0-9a-f]{8}$/)
      await expect(nameInput).toHaveValue('')

      // Unnamed again: the publish gate blocks the draft
      const publish = await request.post(`/api/v1/packages/${draft.id}/publish`)
      expect(publish.status()).toBe(400)
    } finally {
      await request.delete(`/api/v1/packages/${draft.id}`).catch(() => {})
    }
  })

  test('deleting a draft purges it immediately', async ({ request }) => {
    const createRes = await request.post('/api/v1/packages/drafts', {
      data: { title: 'E2E Draft To Delete' },
    })
    expect(createRes.status()).toBe(201)
    const draft = await createRes.json()

    const deleteRes = await request.delete(`/api/v1/packages/${draft.id}`)
    expect(deleteRes.ok()).toBe(true)

    // Gone for good — no trash, no restore (ADR-039)
    const res = await request.get(`/api/v1/packages/${draft.id}?state=draft`)
    expect(res.status()).toBe(404)
  })
})
