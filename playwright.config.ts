import { defineConfig, devices } from '@playwright/test'
import { USER_FILE } from './apps/web/src/__tests__/e2e/helpers'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './apps/web/src/__tests__/e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  globalSetup: './apps/web/src/__tests__/e2e/global-setup.ts',
  globalTeardown: './apps/web/src/__tests__/e2e/global-teardown.ts',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: USER_FILE,
      },
      dependencies: ['setup'],
    },
  ],

  webServer: {
    command: 'pnpm --filter @kukan/web dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
