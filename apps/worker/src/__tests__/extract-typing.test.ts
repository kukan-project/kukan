import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'
import type { PipelineContext } from '../pipeline/types'

// Capture what extract feeds to the Parquet writer so we can assert per-column
// type inference + cell conversion (ADR-029) without a Parquet reader. The real
// writer accepting these values is already exercised by extract.test.ts.
const parquetWriteBuffer = vi.fn(() => new Uint8Array([1, 2, 3]))
vi.mock('hyparquet-writer', () => ({
  parquetWriteBuffer: (...args: unknown[]) => parquetWriteBuffer(...args),
}))

import { executeExtract } from '../pipeline/steps/extract'

interface CapturedColumn {
  name: string
  type: string
  data: unknown[]
}

function createMockCtx() {
  return {
    storage: { download: vi.fn(), upload: vi.fn() },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    acquireFetchSlot: vi.fn(),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
  } satisfies PipelineContext
}

describe('executeExtract — column typing (ADR-029)', () => {
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(() => {
    ctx = createMockCtx()
    parquetWriteBuffer.mockClear()
  })

  it('infers per-column types and converts cells (typed empties → null, strings keep raw text)', async () => {
    ctx.storage.download.mockResolvedValue(
      Readable.from(
        Buffer.from(
          'id,price,flag,name,code\n' +
            '1,1.5,true,Alice,001\n' +
            '2,,false,Bob,002\n' +
            '3,3.25,true,Carol,003\n'
        )
      )
    )

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)

    expect(parquetWriteBuffer).toHaveBeenCalledOnce()
    const { columnData } = parquetWriteBuffer.mock.calls[0][0] as { columnData: CapturedColumn[] }
    const byName = Object.fromEntries(columnData.map((c) => [c.name, c]))

    // Integer column → INT64 (bigint values)
    expect(byName.id.type).toBe('INT64')
    expect(byName.id.data).toEqual([1n, 2n, 3n])

    // Float column with an empty cell → DOUBLE with null
    expect(byName.price.type).toBe('DOUBLE')
    expect(byName.price.data).toEqual([1.5, null, 3.25])

    // Boolean column → BOOLEAN
    expect(byName.flag.type).toBe('BOOLEAN')
    expect(byName.flag.data).toEqual([true, false, true])

    // Text column → STRING (raw strings)
    expect(byName.name.type).toBe('STRING')
    expect(byName.name.data).toEqual(['Alice', 'Bob', 'Carol'])

    // Leading-zero codes stay STRING (not coerced to integers)
    expect(byName.code.type).toBe('STRING')
    expect(byName.code.data).toEqual(['001', '002', '003'])
  })

  it('keeps data rows whose leading (category) column is blank', async () => {
    // Japanese government CSVs often leave the first column empty on data rows.
    // These must NOT be dropped as footer rows (regression: whole table → 0 rows).
    ctx.storage.download.mockResolvedValue(
      Readable.from(
        Buffer.from(
          'category,item,amount\n' +
            'A,apple,10\n' +
            ',banana,20\n' + // blank leading column but real data
            ',cherry,30\n'
        )
      )
    )

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)

    expect(parquetWriteBuffer).toHaveBeenCalledOnce()
    const { columnData } = parquetWriteBuffer.mock.calls[0][0] as { columnData: CapturedColumn[] }
    const byName = Object.fromEntries(columnData.map((c) => [c.name, c]))

    // All three data rows survive (none treated as footer).
    expect(byName.item.data).toEqual(['apple', 'banana', 'cherry'])
    expect(byName.amount.data).toEqual([10n, 20n, 30n])
    expect(byName.category.data).toEqual(['A', '', ''])
  })

  it('returns the persisted column schema (ADR-032)', async () => {
    ctx.storage.download.mockResolvedValue(
      Readable.from(
        Buffer.from('id,price,name\n' + '1,1.5,Alice\n' + '2,,Bob\n' + '3,3.25,Carol\n')
      )
    )

    const result = await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)

    expect(result?.previewKey).toBeTruthy()
    expect(result?.schema).toEqual({
      rowCount: 3,
      columns: [
        {
          name: 'id',
          type: 'integer',
          nullable: false,
          nullCount: 0,
          stats: { min: '1', max: '3' },
        },
        {
          name: 'price',
          type: 'float',
          nullable: true,
          nullCount: 1,
          stats: { min: 1.5, max: 3.25 },
        },
        { name: 'name', type: 'string', nullable: false, nullCount: 0 },
      ],
    })
  })

  it('keeps all rows of a single-column CSV (footer rule is multi-column only)', async () => {
    // Every value row has exactly one non-empty cell; the "nearly empty" footer
    // rule must not apply to single-column CSVs (regression: 0-row preview).
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from('name\nAlice\nBob\n')))

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)

    expect(parquetWriteBuffer).toHaveBeenCalledOnce()
    const { columnData } = parquetWriteBuffer.mock.calls[0][0] as { columnData: CapturedColumn[] }
    expect(columnData).toHaveLength(1)
    expect(columnData[0].name).toBe('name')
    expect(columnData[0].data).toEqual(['Alice', 'Bob'])
  })
})
