/**
 * E2E: Brand override layer
 */

import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Brand pages', () => {
  test('terms page renders correctly', async ({ page }) => {
    await page.goto('/terms')

    await expect(page).toHaveTitle(/利用規約/)
    await expect(page.locator('h1')).toHaveText('利用規約')
    await expect(page.locator('h2').first()).toBeVisible()
  })

  test('unregistered brand page shows 404', async ({ page }) => {
    await page.goto('/nonexistent-brand-page')

    await expect(page.locator('h1')).toHaveText('404')
  })
})

test.describe('Brand config', () => {
  test('header displays siteName', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('header')).toContainText('KUKAN')
  })

  test('footer displays copyright and footer links', async ({ page }) => {
    await page.goto('/')

    const footer = page.locator('footer')
    await expect(footer).toContainText('KUKAN')
    await expect(footer).toContainText('KUKAN Contributors')
    await expect(footer.locator('a[href="/terms"]')).toHaveText('Terms of Use')
  })

  test.describe('ja locale', () => {
    test.use({ locale: 'ja' })

    test('footer link label follows the locale', async ({ page }) => {
      await page.goto('/')

      await expect(page.locator('footer a[href="/terms"]')).toHaveText('利用規約')
    })
  })
})
