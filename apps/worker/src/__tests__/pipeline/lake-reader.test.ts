import { describe, it, expect, vi } from 'vitest'
import { lakeVersionReader } from '../../pipeline/lake-reader'
import { WorkerStoppingError } from '../../heavy/process'
import { createPipelineContextMock } from '../test-helpers/pipeline-context'

/** What the interpretation does with the file; the reader's own decisions are what is tested. */
const interpretation = vi.hoisted(() => ({
  run: async (use: (t: { parquetPath: string }) => Promise<unknown>): Promise<unknown> => ({
    used: await use({ parquetPath: '/tmp/v.parquet' }),
  }),
}))

vi.mock('../../pipeline/interpret/version', () => ({
  withInterpretedVersion: vi.fn(
    (_s: unknown, _f: string, _c: unknown, use: (t: { parquetPath: string }) => Promise<unknown>) =>
      interpretation.run(use)
  ),
}))

const file = { resourceId: 'r', version: 2, storageKey: 'k', size: 1, format: 'CSV' }
const read = () => lakeVersionReader(createPipelineContextMock())(file, async () => 'loaded')

describe('lakeVersionReader', () => {
  it('hands the table to the load', async () => {
    expect(await read()).toEqual({ table: true, value: 'loaded' })
  })

  it("answers with the error when the reading fails, as the version's", async () => {
    const err = new Error('unreadable')
    interpretation.run = async () => {
      throw err
    }

    expect(await read()).toEqual({ table: false, failed: err })
  })

  it('throws what cut the work short, which is no fault of the version', async () => {
    interpretation.run = async () => {
      throw new WorkerStoppingError()
    }

    await expect(read()).rejects.toBeInstanceOf(WorkerStoppingError)
  })

  it("throws what the load threw, which is the catalog's", async () => {
    interpretation.run = async (use) => ({ used: await use({ parquetPath: '/tmp/v.parquet' }) })

    await expect(
      lakeVersionReader(createPipelineContextMock())(file, async () => {
        throw new Error('catalog write failed')
      })
    ).rejects.toThrow('catalog write failed')
  })
})
