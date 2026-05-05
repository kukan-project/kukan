/**
 * Playwright E2E global teardown.
 * Cleans up all E2E test data after the test run.
 */

import { cleanupE2eData } from './helpers'

export default async function globalTeardown() {
  await cleanupE2eData()
}
