/**
 * Playwright setup project — create test users and save storageState.
 *
 * Runs before all other E2E tests. Creates two users:
 * - e2e-user@test.local (regular user) → .auth/user.json
 * - e2e-admin@test.local (sysadmin) → .auth/admin.json
 */

import { test as setup, expect, type Page } from '@playwright/test'
import pg from 'pg'
import { USER_FILE, ADMIN_FILE, TEST_PASSWORD, DB_URL } from './helpers'

/** Try sign-in; returns true on dashboard redirect, false on timeout */
async function trySignIn(page: Page, email: string, password: string) {
  await page.goto('/auth/sign-in')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.locator('button[type="submit"]').click()

  try {
    await page.waitForURL('/dashboard', { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

async function doSignUp(page: Page, name: string, email: string, password: string) {
  await page.goto('/auth/sign-up')
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL('/dashboard', { timeout: 15_000 })
}

setup('create regular user', async ({ page }) => {
  const signedIn = await trySignIn(page, 'e2e-user@test.local', TEST_PASSWORD)
  if (!signedIn) {
    await doSignUp(page, 'e2e-user', 'e2e-user@test.local', TEST_PASSWORD)
  }
  await expect(page).toHaveURL('/dashboard')
  await page.context().storageState({ path: USER_FILE })
})

setup('create admin user', async ({ page }) => {
  const signedIn = await trySignIn(page, 'e2e-admin@test.local', TEST_PASSWORD)
  if (!signedIn) {
    await doSignUp(page, 'e2e-admin', 'e2e-admin@test.local', TEST_PASSWORD)
  }
  await expect(page).toHaveURL('/dashboard')

  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    await client.query(`UPDATE "user" SET role = 'sysadmin' WHERE email = 'e2e-admin@test.local'`)
  } finally {
    await client.end()
  }

  await page.reload()
  await page.waitForURL('/dashboard', { timeout: 10_000 })
  await page.context().storageState({ path: ADMIN_FILE })
})
