import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'stream'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeExtract } from '../pipeline/steps/extract'
import {
  captureUpload,
  createPipelineContextMock,
  type UploadCapture,
} from './test-helpers/pipeline-context'

/**
 * Column typing, asserted against the Parquet that actually leaves the step.
 *
 * The interpretation moved onto DuckDB (ADR-046), so there is no longer an
 * in-process writer whose inputs could stand in for the result — and reading
 * the file back is the stronger check anyway: it covers the types, the values
 * and the null handling in one go.
 */
describe('executeExtract — column typing', () => {
  let ctx: ReturnType<typeof createPipelineContextMock>
  let upload: UploadCapture
  let dir: string
  let conn: DuckDBConnection

  beforeEach(async () => {
    ctx = createPipelineContextMock()
    upload = captureUpload(ctx)
    dir = mkdtempSync(join(tmpdir(), 'kukan-typing-'))
    conn = await (await DuckDBInstance.create(':memory:')).connect()
  })

  afterEach(() => {
    conn?.disconnectSync()
    rmSync(dir, { recursive: true, force: true })
  })

  function csv(content: string) {
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from(content)))
  }

  /** The uploaded preview, back as rows and column types. */
  async function readPreview() {
    const path = join(dir, 'preview.parquet')
    writeFileSync(path, upload.body!)
    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${path}')`)
    const types = Object.fromEntries(
      (described.getRowObjectsJson() as { column_name: string; column_type: string }[]).map((r) => [
        r.column_name,
        r.column_type,
      ])
    )
    const rows = (
      await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}')`)
    ).getRowObjectsJson() as Record<string, unknown>[]
    return { types, rows }
  }

  it('types each column and keeps leading-zero codes as text', async () => {
    csv(
      'id,price,flag,name,code\n' +
        '1,1.5,true,Alice,001\n' +
        '2,,false,Bob,002\n' +
        '3,3.25,true,Carol,003\n'
    )

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)
    const { types, rows } = await readPreview()

    expect(types).toEqual({
      id: 'BIGINT',
      price: 'DOUBLE',
      flag: 'BOOLEAN',
      name: 'VARCHAR',
      // Coercing these to integers would drop the leading zero — the guard the
      // hand-written inference existed for, which the sniffer makes on its own.
      code: 'VARCHAR',
    })
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(rows.map((r) => r.price)).toEqual([1.5, null, 3.25])
    expect(rows.map((r) => r.flag)).toEqual([true, false, true])
    expect(rows.map((r) => r.code)).toEqual(['001', '002', '003'])
  })

  it('keeps data rows whose leading (category) column is blank', async () => {
    // Japanese government CSVs often leave the first column empty on data rows.
    // These must NOT be dropped as footer rows (regression: whole table → 0 rows).
    csv('category,item,amount\n' + 'A,apple,10\n' + ',banana,20\n' + ',cherry,30\n')

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)
    const { rows } = await readPreview()

    expect(rows.map((r) => r.item)).toEqual(['apple', 'banana', 'cherry'])
    expect(rows.map((r) => r.amount)).toEqual(['10', '20', '30'])
    expect(rows.map((r) => r.category)).toEqual(['A', null, null])
  })

  it('returns the persisted column schema (ADR-032)', async () => {
    csv('id,price,name\n' + '1,1.5,Alice\n' + '2,,Bob\n' + '3,3.25,Carol\n')

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
          distinctCount: 3,
          unique: true,
          stats: { min: '1', max: '3' },
        },
        {
          name: 'price',
          type: 'float',
          nullable: true,
          nullCount: 1,
          distinctCount: 2,
          // A missing value disqualifies the column from identifying a row.
          unique: false,
          stats: { min: 1.5, max: 3.25 },
        },
        {
          name: 'name',
          type: 'string',
          nullable: false,
          nullCount: 0,
          distinctCount: 3,
          unique: true,
        },
      ],
    })
  })

  it('keeps all rows of a single-column CSV (footer rule is multi-column only)', async () => {
    // Every value row has exactly one non-empty cell; the "nearly empty" footer
    // rule must not apply to single-column CSVs (regression: 0-row preview).
    csv('name\nAlice\nBob\n')

    await executeExtract('r', 'p', 'resources/p/r', 'CSV', ctx)
    const { types, rows } = await readPreview()

    expect(Object.keys(types)).toEqual(['name'])
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob'])
  })
})
