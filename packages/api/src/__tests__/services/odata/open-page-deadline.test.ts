import { describe, it, expect, vi } from 'vitest'
import { RequestTimeoutError, type Env } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { DuckdbHandle } from '@kukan/lake'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { OdataService, type OdataFeed } from '../../../services/odata/odata-service'

// Preparing an instance stalls until the test lets it land
const prepare = vi.hoisted(() => ({ land: undefined as (() => void) | undefined }))
const closeSync = vi.hoisted(() => vi.fn())
const disconnectSync = vi.hoisted(() => vi.fn())

vi.mock('../../../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config')>()),
  ODATA_READ_TIMEOUT_MS: 50,
}))
vi.mock('../../../services/odata/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/odata/session')>()),
  prepareFeedInstance: () =>
    new Promise<DuckdbHandle>((resolve) => {
      prepare.land = () =>
        resolve({
          instance: { closeSync },
          conn: { disconnectSync, interrupt: vi.fn() },
          dropTempDir: async () => {},
        } as unknown as DuckdbHandle)
    }),
}))

const feed = {
  ok: true,
  previewKey: 'previews/a.parquet',
  rowBytes: 100,
  rowGroupRows: 1000,
} as Extract<OdataFeed, { ok: true }>
const storage = { readUrl: () => 's3://bucket/previews/a.parquet' } as unknown as StorageAdapter

describe('OdataService.openPage', () => {
  it('times out an instance that stalls while it is prepared, and pools it when it lands', async () => {
    const service = new OdataService({} as Database, storage, {} as Env)
    await expect(service.openPage(feed, { skip: 0, limit: 10 })).rejects.toThrow(
      RequestTimeoutError
    )

    expect(disconnectSync).not.toHaveBeenCalled()
    prepare.land!()
    // Handed back with its connection let go, and kept for the retry
    await vi.waitFor(() => expect(disconnectSync).toHaveBeenCalled())
    expect(closeSync).not.toHaveBeenCalled()
  })
})
