/**
 * E2E: Authentication flow
 */

import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

const TEST_PASSWORD = 'auth-test-password-123'

test.describe('Authentication', () => {
  test.describe.configure({ mode: 'serial' })

  const uniqueSuffix = Date.now()
  const signUpEmail = `e2e-auth-signup-${uniqueSuffix}@test.local`
  const signUpName = `e2e-auth-${uniqueSuffix}`

  test('sign up creates account and redirects to dashboard', async ({ page }) => {
    await page.goto('/auth/sign-up')
    await page.locator('#name').fill(signUpName)
    await page.locator('#email').fill(signUpEmail)
    await page.locator('#password').fill(TEST_PASSWORD)
    await page.locator('button[type="submit"]').click()

    await expect(page).toHaveURL('/dashboard', { timeout: 15_000 })
  })

  test('sign in with existing account', async ({ page }) => {
    await page.goto('/auth/sign-in')
    await page.locator('#email').fill(signUpEmail)
    await page.locator('#password').fill(TEST_PASSWORD)
    await page.locator('button[type="submit"]').click()

    await expect(page).toHaveURL('/dashboard', { timeout: 15_000 })
  })

  test('unauthenticated user is redirected from dashboard', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/auth\/sign-in/, { timeout: 10_000 })
  })
})
