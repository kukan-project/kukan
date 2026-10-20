import { describe, it, expect, vi } from 'vitest'
import { lakeVersionReader } from '../../pipeline/lake-reader'
import { WorkerStoppingError } from '../../heavy/process'
import { createPipelineContextMock } from '../test-helpers/pipeline-context'
import type { PipelineContext } from '../../pipeline/run/types'

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

vi.mock('@kukan/api/services/pipeline/pipeline-claim', () => ({
  touchResourceClaim: vi.fn(async () => {}),
}))

import { withInterpretedVersion } from '../../pipeline/interpret/version'
import { touchResourceClaim } from '@kukan/api/services/pipeline/pipeline-claim'

const db = { execute: vi.fn() }
const file = { resourceId: 'r', version: 2, storageKey: 'k', size: 1, format: 'CSV' }
const read = () => lakeVersionReader(createPipelineContextMock(), db)(file, async () => 'loaded')

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
      lakeVersionReader(createPipelineContextMock(), db)(file, async () => {
        throw new Error('catalog write failed')
      })
    ).rejects.toThrow('catalog write failed')
  })

  it('keeps the claim it is read under alive while the version is interpreted', async () => {
    interpretation.run = async (use) => ({ used: await use({ parquetPath: '/tmp/v.parquet' }) })
    const claim = { id: 'c', resourceId: 'r', owner: 'o' }

    await lakeVersionReader(createPipelineContextMock(), db)(file, async () => 'loaded', claim)

    const ctx = vi.mocked(withInterpretedVersion).mock.lastCall![2] as PipelineContext
    await ctx.keepHeld!()
    expect(touchResourceClaim).toHaveBeenCalledWith(db, claim)
  })
})
