/**
 * Playwright E2E global teardown.
 * Cleans up all E2E test data after the test run via API.
 */

import { cleanupE2eData, createAdminRequest } from './helpers'

export default async function globalTeardown() {
  try {
    const request = await createAdminRequest()
    await cleanupE2eData(request)
    await request.dispose()
  } catch {
    // Admin storageState may not exist if setup failed — skip cleanup
  }
}
