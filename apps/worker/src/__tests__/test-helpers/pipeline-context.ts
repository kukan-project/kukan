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
import type { Readable } from 'node:stream'
import type { PipelineContext } from '../../pipeline/types'
import { streamToBuffer } from '../../pipeline/node-utils'

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
    versionForContent: vi
      .fn()
      .mockResolvedValue({ version: 1, storageKey: 'versions/v1', size: 1024, format: 'CSV' }),
    recordVersionSchema: vi.fn(),
    pendingLakeVersion: vi.fn().mockResolvedValue(null),
    ingestLakeVersion: vi.fn().mockResolvedValue(null),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
  } satisfies PipelineContext
  return ctx as PipelineContextMock
}

/** What the last `putObject` was handed, filled in once the step has run. */
export interface UploadCapture {
  body: Buffer | undefined
}

/**
 * Collect the bytes of whatever the step uploads.
 *
 * A preview is uploaded as a stream off local disk (ADR-046) and the file is
 * removed as soon as the step returns, so the bytes have to be taken as they go
 * past to be asserted on at all.
 */
export function captureUpload(ctx: PipelineContextMock): UploadCapture {
  const capture: UploadCapture = { body: undefined }
  ctx.putObject.mockImplementation(async (_key: string, body: Buffer | Readable) => {
    capture.body = Buffer.isBuffer(body) ? body : await streamToBuffer(body)
  })
  return capture
}

/** The context with `vi.fn()`'s methods still on every member. */
export type PipelineContextMock = Mocked<Omit<PipelineContext, 'storage'>> & {
  // Spelled out because `Mocked` does not reach into a nested object, and the
  // tests drive the download from here.
  storage: Mocked<PipelineContext['storage']>
}
