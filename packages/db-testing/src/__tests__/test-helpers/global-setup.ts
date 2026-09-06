/**
 * Vitest globalSetup for the migration tests.
 *
 * Same run-scoped naming and lock as every other integration suite — this
 * package is where that lives, which is why the tests moved here from
 * @kukan/db, whose dependency on it ran the other way.
 */
import type { TestProject } from 'vitest/node'
import { setupTestDatabase } from '../../index'

declare module 'vitest' {
  interface ProvidedContext {
    testDbPrefix: string
  }
}

/** Returned rather than awaited into nothing: the return value is the teardown
 *  vitest calls when the run ends. */
export async function setup(project: TestProject) {
  const { prefix, teardown } = await setupTestDatabase('migrate')
  project.provide('testDbPrefix', prefix)
  return teardown
}
