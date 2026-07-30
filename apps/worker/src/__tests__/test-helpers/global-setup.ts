/**
 * Vitest globalSetup for the worker's integration tests.
 *
 * A database of this project's own: the API's suites truncate the same tables
 * between tests, and vitest runs the two projects concurrently.
 */
import { setupTestDatabase } from '@kukan/db/testing'

export const WORKER_TEST_DB = 'kukan_worker_test'

export const setup = () => setupTestDatabase(WORKER_TEST_DB)
