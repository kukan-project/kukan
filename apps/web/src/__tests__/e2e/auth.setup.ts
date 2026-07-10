/**
 * Playwright setup project — create test users and save storageState.
 *
 * Runs before all other E2E tests. Creates two users:
 * - e2e-user@test.local (regular user) → .auth/user.json
 * - e2e-admin@test.local (sysadmin) → .auth/admin.json
 *
 * NOTE: sysadmin promotion requires direct DB access because the PATCH API
 * needs an existing sysadmin session (chicken-and-egg problem).
 */

import { test as setup, expect, type Page } from '@playwright/test'
import pg from 'pg'
import { USER_FILE, ADMIN_FILE, TEST_PASSWORD, DB_URL } from './helpers'

async function runSql(query: string) {
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

// Self-registration defaults to off (ADR-038); the sign-up-based user
// creation below needs it on. The API caches settings for up to 30s,
// so poll until the flag is effective.
setup('enable self-registration', async ({ request }) => {
  await runSql(`
    INSERT INTO system_setting (key, value) VALUES ('registration-enabled', 'true'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated = now()
  `)
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/v1/site/settings')
        return (await res.json()).registrationEnabled
      },
      // Gentle backoff — the flag flips within the 30s settings-cache TTL
      { timeout: 45_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe(true)
})

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

  // On an empty database the first sign-up is bootstrap-promoted to sysadmin
  // (ADR-038) — force the regular role so permission tests stay meaningful
  await runSql(`UPDATE "user" SET role = 'user' WHERE email = 'e2e-user@test.local'`)

  await page.context().storageState({ path: USER_FILE })
})

setup('create admin user', async ({ page }) => {
  const signedIn = await trySignIn(page, 'e2e-admin@test.local', TEST_PASSWORD)
  if (!signedIn) {
    await doSignUp(page, 'e2e-admin', 'e2e-admin@test.local', TEST_PASSWORD)
  }
  await expect(page).toHaveURL('/dashboard')

  // Promote to sysadmin via direct DB (PATCH API requires existing sysadmin session)
  await runSql(`UPDATE "user" SET role = 'sysadmin' WHERE email = 'e2e-admin@test.local'`)

  await page.reload()
  await page.waitForURL('/dashboard', { timeout: 10_000 })
  await page.context().storageState({ path: ADMIN_FILE })
})
