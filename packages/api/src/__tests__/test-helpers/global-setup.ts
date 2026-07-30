/** Vitest globalSetup for the API's integration tests. */
import { setupTestDatabase } from '@kukan/db/testing'

export const API_TEST_DB = 'kukan_test'

export const setup = () => setupTestDatabase(API_TEST_DB)
