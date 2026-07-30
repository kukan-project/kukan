/**
 * A complete `PipelineContext` of mocks, for the step tests.
 *
 * One of these rather than one per file: the context is what every step is
 * handed, so a method added to it — or narrowed, as `storage` was to `download`
 * alone (ADR-045) — otherwise has to be chased through four literals, and the
 * ones that cast their way past the type never say anything at all.
 *
 * Complete, so a step reaching for something the test did not stub gets an
 * `undefined is not a function` naming the method rather than a mock that
 * quietly answers.
 */
import { vi, type Mocked } from 'vitest'
import type { PipelineContext } from '../../pipeline/types'

export function createPipelineContextMock(): PipelineContextMock {
  // `satisfies` is the point: a context member added or removed shows up here
  // rather than in whichever test happens to touch it.
  const ctx = {
    storage: { download: vi.fn() },
    getResource: vi.fn(),
    getPackageState: vi.fn(),
    publishContent: vi.fn().mockResolvedValue(true),
    putObject: vi.fn(),
    acquireFetchSlot: vi.fn().mockResolvedValue(true),
    captureVersion: vi.fn().mockResolvedValue({ captured: false }),
    pendingLakeVersion: vi.fn().mockResolvedValue(null),
    deferLakeIngest: vi.fn(),
    ingestLakeVersion: vi.fn().mockResolvedValue(null),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
  } satisfies PipelineContext
  return ctx as PipelineContextMock
}

/** The context with `vi.fn()`'s methods still on every member. */
export type PipelineContextMock = Mocked<Omit<PipelineContext, 'storage'>> & {
  // Spelled out because `Mocked` does not reach into a nested object, and the
  // tests drive the download from here.
  storage: Mocked<PipelineContext['storage']>
}
