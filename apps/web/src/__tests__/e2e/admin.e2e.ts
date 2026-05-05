/**
 * E2E: Admin panel
 */

import { test, expect } from '@playwright/test'
import { ADMIN_FILE } from './helpers'

test.use({ storageState: ADMIN_FILE })

test.describe('Admin', () => {
  test('search admin page loads with index stats', async ({ page }) => {
    await page.goto('/dashboard/admin/search')

    await expect(page.locator('main')).toContainText(/packages|パッケージ/i, {
      timeout: 10_000,
    })
  })

  test('reindex metadata executes successfully', async ({ page }) => {
    await page.goto('/dashboard/admin/search')

    const reindexButton = page.getByRole('button', {
      name: /rebuild|再構築/i,
    })
    await reindexButton.click()

    await expect(page.locator('main')).toContainText(/indexed|インデックス/i, { timeout: 30_000 })
  })

  test('job management section is visible', async ({ page }) => {
    await page.goto('/dashboard/admin/search')

    await expect(page.locator('main')).toContainText(/キュー|ジョブ管理|Job Management/i, {
      timeout: 10_000,
    })
  })
})
