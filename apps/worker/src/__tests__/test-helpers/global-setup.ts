/**
 * Vitest globalSetup for the worker's integration tests.
 *
 * The prefix goes through vitest's `provide`, which is scoped to the project —
 * so both integration projects can name theirs the same thing and neither sees
 * the other's. An environment variable would not: both projects' setup runs in
 * one process before any worker forks, so the second would overwrite the first
 * and put both suites on one database.
 */
import type { TestProject } from 'vitest/node'
import { setupTestDatabase } from '@kukan/db-testing'

declare module 'vitest' {
  interface ProvidedContext {
    testDbPrefix: string
  }
}

/** Returned rather than awaited into nothing: the return value is the teardown
 *  vitest calls when the run ends. */
export async function setup(project: TestProject) {
  const { prefix, teardown } = await setupTestDatabase('worker')
  project.provide('testDbPrefix', prefix)
  return teardown
}
