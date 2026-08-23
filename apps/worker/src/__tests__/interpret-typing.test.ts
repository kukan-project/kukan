import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'stream'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeInterpret } from '../pipeline/steps/interpret'
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
/** The created version the step reads (ADR-046); sized under the interpret cap. */
const version = (storageKey: string, size = 1024) => ({ storageKey, size })

describe('executeInterpret — column typing', () => {
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

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
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

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
    const { rows } = await readPreview()

    expect(rows.map((r) => r.item)).toEqual(['apple', 'banana', 'cherry'])
    expect(rows.map((r) => r.amount)).toEqual(['10', '20', '30'])
    expect(rows.map((r) => r.category)).toEqual(['A', null, null])
  })

  /** A ten-column table: wide enough that a two-cell line is not a row of it. */
  function wide(rows: number, tail = '') {
    const header = Array.from({ length: 10 }, (_, i) => `c${i}`).join(',')
    const body = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: 10 }, (_, i) => 1000 + r * 100 + i).join(',')
    ).join('\n')
    return `${header}\n${body}\n${tail}`
  }

  it('splits the columns of a CSV that ends in a note', async () => {
    // Japanese open data routinely signs a file off with a version line or a
    // source note. It is narrower than the rest, and that is enough for DuckDB's
    // sniffer to give up on the delimiter and read the whole file as a single
    // VARCHAR column named after the header line — silently, with the ingest
    // reporting success.
    csv(wide(5, '港区の人口・世帯数（住民基本台帳に基づく） ,Ver202608\n'))

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
    const { types, rows } = await readPreview()

    expect(Object.keys(types)).toHaveLength(10)
    // And the types the data implies, which is what is lost by reading the file
    // with the note still in it.
    expect(types.c0).toBe('BIGINT')
    expect(rows).toHaveLength(5)
  })

  it('takes two values in a table of ten columns as a note, not a row', async () => {
    // The whole of the evidence: a row that lost eight of its ten fields is not
    // how rows break. Neither the position of the line nor what its values look
    // like is consulted — and it is a guess, so what it dropped is counted.
    csv(wide(5, '出典: 港区,2026\n'))

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.rowCount).toBe(5)
    expect(result?.schema?.droppedRows).toBe(1)
    expect(result?.schema?.droppedLines).toEqual([7])
  })

  it('refuses two values in a table of three columns, where losing one is ordinary', async () => {
    // The same two values, and now they are a row that lost its last field. The
    // line sits at the bottom, exactly where a note sits.
    csv('date,people,households\n' + '20020901,88793,76422\n' + '20021001,88900\n')

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBe('ragged-rows')
    expect(result?.schema?.columns).toEqual([])
    // Named, because the remedy is to go and fix that line.
    expect(result?.schema?.droppedLines).toEqual([3])
    // Nothing was published: a refusal that still uploads a preview is not one.
    expect(result?.previewKey).toBeFalsy()
  })

  it('refuses a row whose values are broken, which no cast would recognise', async () => {
    // The refused lines took no part in deciding the types, so a cast that fails
    // is evidence of nothing: `2002/10/01` and `N/A` are a date and a count that
    // did not survive, and they fail every cast this table would ask of them.
    // The shape is what says this is a row.
    csv('date,people,households\n' + '20020901,88793,76422\n' + '2002/10/01,N/A\n')

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBe('ragged-rows')
    expect(result?.previewKey).toBeFalsy()
  })

  it('refuses a line in the middle on the same terms as one at the end', async () => {
    // Position is not consulted, so this is refused for what it is rather than
    // for where it is. The same two values at the bottom of the same table are
    // refused too, one test up.
    csv(
      'date,people,households\n' +
        '20020901,88793,76422\n' +
        '20021001,88900\n' +
        '20021101,89010,76610\n'
    )

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBe('ragged-rows')
    expect(result?.schema?.droppedLines).toEqual([3])
  })

  it('counts a quoted sign-off by its values, not by its quotes', async () => {
    // The shape of the file #449 was reported on: every cell quoted, sign-off
    // included. What is stored for a refused line is the raw text, so the quotes
    // are still on it — and read as text rather than parsed, this is the file
    // the whole change exists for, refused.
    csv(wide(5, '"港区施設情報 区役所・総合支所","Ver20260804"\n'))

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.rowCount).toBe(5)
    expect(result?.schema?.droppedRows).toBe(1)
  })

  it('reads a file that escapes its quotes with a backslash', async () => {
    // `escape` is its own dialect and DuckDB records which one it found. Read
    // with the parser's default — the quote character — the sign-off is
    // unparseable, so it counts as a row and the resource loses its table.
    const header = 'c0,c1,c2,c3,c4,c5\n'
    const body = Array.from({ length: 4 }, (_, r) => `${r},"a \\"x\\" b",2,3,4,5`).join('\n')
    csv(`${header}${body}\n"出典: 港区 \\"庁舎\\"","Ver1"\n`)

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.rowCount).toBe(4)
    expect(result?.schema?.droppedRows).toBe(1)
  })

  it('judges every refused line, however many the schema will report', async () => {
    // How many line numbers the schema carries out to a reader is a display
    // bound, and it must not decide what the file is: twenty-five notes and no
    // broken row is the same file as three notes and no broken row.
    const notes = Array.from({ length: 25 }, (_, i) => `出典: 港区,${i}`).join('\n')
    csv(wide(3, `${notes}\n`))

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.rowCount).toBe(3)
    expect(result?.schema?.droppedRows).toBe(25)
    // Reported up to the bound, and the count says how many there were.
    expect(result?.schema?.droppedLines).toHaveLength(20)
  })

  it('counts a quoted cell holding the delimiter as one value', async () => {
    // Six columns, and a line of two values — one of which holds two commas.
    // Split on the delimiter it looks like four, which is within two of the
    // table's width and would be refused as a row.
    const header = 'c0,c1,c2,c3,c4,c5\n'
    const body = Array.from({ length: 4 }, (_, r) => `${r},1,2,3,4,5`).join('\n')
    csv(`${header}${body}\n"出典: 港区, 統計課, 2026","Ver1"\n`)

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.droppedRows).toBe(1)
  })

  it('still reads a quoted file whose note carries no quotes', async () => {
    // The refusal is per line: quoting elsewhere says nothing about this one.
    const header = 'c0,c1,c2,c3,c4,c5,c6,c7,c8,c9\n'
    const body = Array.from({ length: 4 }, (_, r) => `${r},"a,b",2,3,4,5,6,7,8,9`).join('\n')
    csv(`${header}${body}\n出典: 港区\n`)

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.reason).toBeUndefined()
    expect(result?.schema?.droppedRows).toBe(1)
  })

  it('keeps a total row that carries values, because it is a row', async () => {
    // It splits like every other row and every column is filled. Dropping it is
    // a reading of the file — the publisher's own total, which somebody may
    // have come for — rather than a cleaning of it.
    csv('区分,男,女\n' + '港,10,20\n' + '芝,30,40\n' + '合計,40,60\n')

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
    const { types, rows } = await readPreview()

    expect(Object.keys(types)).toEqual(['区分', '男', '女'])
    expect(rows.map((r) => r.区分)).toEqual(['港', '芝', '合計'])
  })

  it('keeps a row whose first cell merely begins like a footer word', async () => {
    // 計画課 begins with 計 and 注文番号 with 注, and the rule used to delete
    // both — full rows, every column filled, gone from every count the
    // catalogue publishes with nothing recorded.
    csv('部署,男,女\n' + '総務,10,20\n' + '計画課,30,40\n' + '注文番号,50,60\n')

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
    const { rows } = await readPreview()

    expect(rows.map((r) => r.部署)).toEqual(['総務', '計画課', '注文番号'])
  })

  it('drops a note the publisher padded out to the width, and counts it', async () => {
    // The same note the reader refuses when it is written short. Which way the
    // publisher wrote their trailing commas must not decide what the table
    // holds — and either way it is counted, so the row is not missing in
    // silence.
    csv(wide(3, '出典: 港区,2026,,,,,,,,\n'))

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.schema?.rowCount).toBe(3)
    expect(result?.schema?.droppedRows).toBe(1)
    // Nowhere to point: a row trimmed from the table cannot be traced back to a
    // line of the file, since blank lines and quoted newlines are gone by then.
    expect(result?.schema?.droppedLines).toBeUndefined()
  })

  it('reads the same note the same way however many commas end it', async () => {
    // Nothing about the note changes between these; only where the publisher
    // stopped typing. Measured before this, +2 through +5 refused the table
    // outright while +0 and the fully padded one dropped the note.
    for (const commas of [0, 1, 2, 5, 8]) {
      csv(wide(3, `出典: 港区,2026${','.repeat(commas)}\n`))

      const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

      expect(result?.reason, `${commas} trailing commas`).toBeUndefined()
      expect(result?.schema?.rowCount, `${commas} trailing commas`).toBe(3)
      expect(result?.schema?.droppedRows, `${commas} trailing commas`).toBe(1)
    }
  })

  it('counts what each path took, in one number', async () => {
    // One note written short — the reader refuses it — and one padded out. A
    // reader comparing the table against the download wants to know that two
    // rows are not here, not which of two passes took them.
    csv(wide(3, '出典: 港区,2026\n出典: 港区,2026,,,,,,,,\n'))

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.schema?.rowCount).toBe(3)
    expect(result?.schema?.droppedRows).toBe(2)
    // Only the refused one can be located.
    expect(result?.schema?.droppedLines).toHaveLength(1)
  })

  it('keeps an all-but-empty row where the table is too narrow to tell', async () => {
    // Three columns, and `出典: 港区,,` could as easily be a row with only its
    // first field filled. The refused-line rule says the same of a three-column
    // table, so both say keep — which is the direction everything else here
    // errs in.
    csv('区分,男,女\n' + '港,10,20\n' + '芝,30,40\n' + '出典: 港区,,\n')

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.schema?.rowCount).toBe(3)
    expect(result?.schema?.droppedRows).toBeUndefined()
  })

  it('says nothing about dropped rows where none were', async () => {
    csv('name,amount\n' + 'a,1\n' + 'b,2\n')

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

    expect(result?.schema?.rowCount).toBe(2)
    expect(result?.schema?.droppedRows).toBeUndefined()
    expect(result?.schema?.droppedLines).toBeUndefined()
  })

  it('returns the persisted column schema (ADR-032)', async () => {
    csv('id,price,name\n' + '1,1.5,Alice\n' + '2,,Bob\n' + '3,3.25,Carol\n')

    const result = await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)

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

    await executeInterpret('r', 'p', version('resources/p/r'), 'CSV', ctx)
    const { types, rows } = await readPreview()

    expect(Object.keys(types)).toEqual(['name'])
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob'])
  })
})
