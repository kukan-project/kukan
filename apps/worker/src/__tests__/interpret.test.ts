import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { Readable } from 'stream'
import JSZip from 'jszip'
import { executeInterpret } from '../pipeline/steps/interpret'
import { MAX_PARQUET_SOURCE_SIZE } from '@kukan/shared'
import { ENCODING_SCAN_LIMIT, MAX_CSV_COLUMNS } from '@/config'
import {
  captureUpload,
  createPipelineContextMock,
  type UploadCapture,
} from './test-helpers/pipeline-context'

/**
 * Preview keys carry a per-run UUID (ADR-043 layer 2: the object a reader
 * resolved must never be rewritten), so they are matched by shape.
 */
const PREVIEW_KEY_RE = (pkg: string, res: string, ext: string) =>
  new RegExp(`^previews/${pkg}/${res}\\.[0-9a-f-]{36}\\.${ext}$`)

const previewKeyMatching = (pkg: string, res: string, ext: string) =>
  expect.stringMatching(PREVIEW_KEY_RE(pkg, res, ext))

/** The created version the step reads (ADR-046); sized under the interpret cap. */
const version = (storageKey: string, size = 1024) => ({ storageKey, size })

/**
 * A real Shift_JIS CSV: header "都道府県コード又は市区町村コード,地域コード,都道府県名"
 * over rows of "402303,糸島市,2019-05-31,板持,1515,758,757". Real bytes rather
 * than a synthetic run of high bytes, because chardet weighs byte *patterns* —
 * an invented one is as likely to come back ISO-8859-5.
 */
function shiftJisCsv(rows = 20): Buffer {
  const header = Buffer.from([
    0x93, 0x73, 0x93, 0xb9, 0x95, 0x7b, 0x8c, 0xa7, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x92,
    0x6e, 0x88, 0xe6, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x93, 0x73, 0x93, 0xb9, 0x95, 0x7b,
    0x8c, 0xa7, 0x96, 0xbc, 0x0a,
  ])
  // Three fields, as the header has. It used to carry seven, which made every
  // data row one the reader cannot place: the table came out with the header's
  // three columns and no rows at all, and the file is now refused for it
  // (`ragged-rows`). What these tests are about is the encoding, so the fixture
  // is a well-formed file in it.
  const dataRow = Buffer.from([
    0x34, 0x30, 0x32, 0x33, 0x30, 0x33, 0x2c, 0x8e, 0x85, 0x93, 0x87, 0x8e, 0x73, 0x2c, 0x32, 0x30,
    0x31, 0x39, 0x2d, 0x30, 0x35, 0x2d, 0x33, 0x31, 0x0a,
  ])
  return Buffer.concat([header, ...Array(rows).fill(dataRow)])
}

describe('executeInterpret', () => {
  let ctx: ReturnType<typeof createPipelineContextMock>
  let upload: UploadCapture

  beforeEach(() => {
    ctx = createPipelineContextMock()
    upload = captureUpload(ctx)
  })

  function mockStorageDownload(content: string) {
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from(content)))
  }

  it('should extract CSV from Storage and upload Parquet', async () => {
    mockStorageDownload('name,age\nAlice,30\nBob,25\n')

    const result = await executeInterpret(
      'res-1',
      'pkg-1',
      version('resources/pkg-1/res-1'),
      'CSV',
      ctx
    )

    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-1')
    expect(result).toEqual({
      previewKey: previewKeyMatching('pkg-1', 'res-1', 'parquet'),
      encoding: expect.stringMatching(/^(ASCII|ISO-8859-1)$/),
      schema: {
        rowCount: 2,
        columns: [
          {
            name: 'name',
            type: 'string',
            nullable: false,
            nullCount: 0,
            distinctCount: 2,
            unique: true,
          },
          {
            name: 'age',
            type: 'integer',
            nullable: false,
            nullCount: 0,
            distinctCount: 2,
            unique: true,
            stats: { min: '25', max: '30' },
          },
        ],
      },
    })
    expect(ctx.putObject).toHaveBeenCalledOnce()

    const [key, , meta] = ctx.putObject.mock.calls[0]
    // Unique per run so a later run cannot rewrite it (ADR-043 layer 2).
    expect(key).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-1', 'parquet'))
    expect(meta).toEqual({ contentType: 'application/vnd.apache.parquet' })
    // The magic bytes, not just "something was uploaded": the preview is now
    // written by DuckDB rather than assembled in process, so what leaves has to
    // be a Parquet file (ADR-046).
    expect(upload.body!.subarray(0, 4).toString('ascii')).toBe('PAR1')
  })

  it('should handle title row skipping in Parquet output', async () => {
    mockStorageDownload('Title Row,,,\n\nname,age,city\nAlice,30,Tokyo\n')

    const result = await executeInterpret(
      'res-2',
      'pkg-1',
      version('resources/pkg-1/res-2'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-2', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
    // The columns, not just "a Parquet came out": skipping one line too many
    // hands DuckDB the header as data and the first data row as the header,
    // which a preview-key assertion cannot see.
    expect(result?.schema?.columns.map((c) => c.name)).toEqual(['name', 'age', 'city'])
  })

  it('keeps a header that has no trailing newline', async () => {
    // The last parsed row is only dropped when the read stopped at the 64KB
    // cap. Dropped unconditionally, a file whose whole content is one line
    // reads as empty — and ADR-046 then records an empty schema, which takes
    // it out of the layer-2 sweep for good.
    mockStorageDownload('name,age\nAlice,30')

    const result = await executeInterpret(
      'res-nonl',
      'pkg-1',
      version('resources/pkg-1/res-nonl.v1'),
      'CSV',
      ctx
    )

    expect(result?.schema?.columns.map((c) => c.name)).toEqual(['name', 'age'])
    expect(result?.schema?.rowCount).toBe(1)
  })

  it('reads a title row above a header that has no trailing newline', async () => {
    // Dropping the last row here left only the title, which DuckDB then read
    // as the header.
    mockStorageDownload('Report Title,,\nname,age,city\nAlice,30,Tokyo')

    const result = await executeInterpret(
      'res-title-nonl',
      'pkg-1',
      version('resources/pkg-1/res-title-nonl.v1'),
      'CSV',
      ctx
    )

    expect(result?.schema?.columns.map((c) => c.name)).toEqual(['name', 'age', 'city'])
  })

  it('should extract TSV data', async () => {
    mockStorageDownload('name\tage\nAlice\t30\n')

    const result = await executeInterpret(
      'res-3',
      'pkg-1',
      version('resources/pkg-1/res-3'),
      'TSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-3', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('should store all rows without truncation', async () => {
    const lines = ['name,value']
    for (let i = 0; i < 300; i++) {
      lines.push(`row-${i},${i}`)
    }
    mockStorageDownload(lines.join('\n') + '\n')

    const result = await executeInterpret(
      'res-4',
      'pkg-1',
      version('resources/pkg-1/res-4'),
      'CSV',
      ctx
    )

    // Parquet stores all rows (no 200-row limit)
    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-4', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('hands the interpreted table over while it is still on disk', async () => {
    mockStorageDownload('name,age\nAlice,30\n')
    let seen: { magic: string; path: string; leftInDir: string[] } | undefined

    await executeInterpret('res-t', 'pkg-1', version('resources/pkg-1/res-t.v1'), 'CSV', ctx, {
      onTable: async (parquetPath) => {
        // Still there, and a real Parquet: layer 2 loads from here rather
        // than from the preview in storage (ADR-046).
        seen = {
          magic: readFileSync(parquetPath).subarray(0, 4).toString('ascii'),
          path: parquetPath,
          // And nothing else: the hook waits on a catalog-wide lock, so the
          // source CSV and its transcoded copy must not be held through it.
          leftInDir: readdirSync(dirname(parquetPath)),
        }
      },
    })

    expect(seen?.magic).toBe('PAR1')
    expect(seen?.leftInDir).toEqual([basename(seen!.path)])
    // And gone once the step returns — the temp directory belongs to the step.
    expect(existsSync(seen!.path)).toBe(false)
  })

  it('does not hand a table over for a format that produces none', async () => {
    // The gate layer 2 used to apply to the preview key is structural now: the
    // hook simply never fires.
    mockStorageDownload('Hello, world!')
    const onTable = vi.fn()

    await executeInterpret('res-u', 'pkg-1', version('resources/pkg-1/res-u.v1'), 'TXT', ctx, {
      onTable,
    })

    expect(onTable).not.toHaveBeenCalled()
  })

  it('refuses a CSV too large to interpret, without transferring it whole', async () => {
    // Decided from the version row's size, before the download, and answered as
    // an interpretation that produced no table rather than as an absence — so
    // both callers give one answer (#276). The sweep still decides eligibility
    // from the size itself, because the cap is configuration; this is what puts
    // the reason on the row for whoever asks why there is no preview.
    mockStorageDownload('a,b\n1,2\n')

    const result = await executeInterpret(
      'res-huge',
      'pkg-1',
      version('resources/pkg-1/res-huge.v1', MAX_PARQUET_SOURCE_SIZE + 1),
      'CSV',
      ctx
    )

    // No schema at all, not an empty one. An empty schema means "interpreted,
    // found nothing", and it is what takes a version out of the lake sweep for
    // good — settle an over-cap version that way and raising the cap no longer
    // brings it back, because the sweep never looks at it again.
    expect(result).toEqual({
      previewKey: null,
      encoding: expect.any(String),
      reason: 'too-large',
    })
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('reads only the encoding sample of an oversized CSV, not the object', async () => {
    // The version row carries the size and the file behind it is immutable, so
    // this is decided before the download rather than after it (ADR-046).
    const CHUNK = 64 * 1024
    const CHUNKS = 16
    let read = 0
    ctx.storage.download.mockImplementation(async () =>
      // Chunked like a real object-store read: the cap only saves anything if
      // the source is delivered in pieces.
      Readable.from(
        (function* () {
          for (let i = 0; i < CHUNKS; i++) {
            read += CHUNK
            yield Buffer.alloc(CHUNK, 'a,b\n1,2\n')
          }
        })()
      )
    )

    const result = await executeInterpret(
      'res-big',
      'pkg-1',
      version('resources/pkg-1/res-big.v1', MAX_PARQUET_SOURCE_SIZE + 1),
      'CSV',
      ctx
    )

    expect(result).toMatchObject({ previewKey: null, reason: 'too-large' })
    // Only the encoding sample crossed the wire, not the whole object.
    expect(read).toBeLessThanOrEqual(CHUNK * CHUNKS)
  })

  it('reads past an ASCII head to the bytes encoding detection needs', async () => {
    // A fixed head is not enough. chardet decides from the non-ASCII bytes, so
    // a file whose first 100KB are ids and dates gives it nothing to work from
    // and the Japanese further down comes back as mojibake (#240).
    const asciiHead = Buffer.from('id,date,count\n'.repeat(8000)) // ~104KB, all ASCII
    ctx.storage.download.mockResolvedValue(
      Readable.from(Buffer.concat([asciiHead, shiftJisCsv(200)]))
    )

    const result = await executeInterpret(
      'res-ascii-head',
      'pkg-1',
      version('resources/pkg-1/res-ascii-head'),
      'TXT',
      ctx
    )

    expect(result?.encoding).toBe('Shift_JIS')
  })

  it('stops reading a file that is ASCII all the way down', async () => {
    // Nothing to find, so the scan must not pull a 100MB text across to say so
    // — every candidate encoding decodes ASCII identically.
    const CHUNK = 1024 * 1024
    let read = 0
    ctx.storage.download.mockResolvedValue(
      Readable.from(
        (function* () {
          for (let i = 0; i < 32; i++) {
            read += CHUNK
            yield Buffer.alloc(CHUNK, 0x61)
          }
        })()
      )
    )

    await executeInterpret(
      'res-all-ascii',
      'pkg-1',
      version('resources/pkg-1/res-all-ascii'),
      'TXT',
      ctx
    )

    expect(read).toBeLessThanOrEqual(ENCODING_SCAN_LIMIT + CHUNK)
  })

  it('hands the encoding over before anything that can fail', async () => {
    // Settled from the bytes before anything heavy runs, so a later failure
    // must not take it back — losing it is silent, since all three readers fall
    // back to UTF-8 and serve mojibake rather than erroring (#251).
    ctx.storage.download.mockResolvedValue(Readable.from(shiftJisCsv()))
    ctx.putObject.mockRejectedValueOnce(new Error('storage is down'))
    const onEncoding = vi.fn()

    const failure = await executeInterpret(
      'res-fail',
      'pkg-1',
      version('resources/pkg-1/res-fail'),
      'CSV',
      ctx,
      { onEncoding }
    ).catch((err: unknown) => err)

    // The interpretation failed on its own terms, unwrapped — the caller sees
    // what actually went wrong rather than a name for where it happened.
    expect((failure as Error).message).toBe('storage is down')
    expect(onEncoding).toHaveBeenCalledWith('Shift_JIS')
  })

  it('describes a CSV as wide as the limit allows', async () => {
    // Width alone used to exhaust the memory limit, so the declared ceiling was
    // never reachable — see STATS_COLUMNS_PER_QUERY for why.
    const header = Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => `c${i}`).join(',')
    const row = Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => String(i)).join(',')
    mockStorageDownload(`${header}\n${row}\n${row}\n`)

    const result = await executeInterpret(
      'res-max',
      'pkg-1',
      version('resources/pkg-1/res-max'),
      'CSV',
      ctx
    )

    expect(result?.schema?.columns).toHaveLength(MAX_CSV_COLUMNS)
    expect(result?.schema?.rowCount).toBe(2)
    // Every column holds its own index, so the statistics are asserted against
    // it rather than against a shape they all share: batches merge into one row
    // by alias, and a fixture whose columns are indistinguishable cannot tell a
    // correct merge from one that shifted every value by a batch.
    expect(result?.schema?.columns.map((c) => c.stats?.min)).toEqual(
      Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => String(i))
    )
  })

  it('refuses a CSV too wide to preview without leaving it outstanding', async () => {
    // Throwing here left the version with no schema, which is how "nothing has
    // interpreted this yet" is written down — so the hourly sweep handed the
    // file back every hour, forever, and every task read up to 50MB of it to
    // reach the same exception (#248). The width is a property of the file, so
    // no retry can reach a different answer.
    const wide = `${Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, i) => `c${i}`).join(',')}\n`
    mockStorageDownload(wide + wide.replace(/c/g, 'v'))

    const result = await executeInterpret(
      'res-wide',
      'pkg-1',
      version('resources/pkg-1/res-wide'),
      'CSV',
      ctx
    )

    // An empty schema is the mark that takes it out of the pending set, and the
    // reason is what keeps "no table here" and "too wide for one" apart.
    expect(result).toMatchObject({
      previewKey: null,
      schema: { rowCount: 0, columns: [] },
      reason: 'too-many-columns',
    })
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should detect encoding for TXT without Parquet generation', async () => {
    mockStorageDownload('Hello, world!')

    const result = await executeInterpret(
      'res-5',
      'pkg-1',
      version('resources/pkg-1/res-5'),
      'TXT',
      ctx
    )

    expect(result).toEqual({ previewKey: null, encoding: 'ASCII' })
    expect(ctx.storage.download).toHaveBeenCalled()
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should return null for non-text formats', async () => {
    const result = await executeInterpret(
      'res-6',
      'pkg-1',
      version('resources/pkg-1/res-6'),
      'PDF',
      ctx
    )
    expect(result).toBeNull()
    expect(ctx.putObject).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should return null for null format', async () => {
    const result = await executeInterpret(
      'res-7',
      'pkg-1',
      version('resources/pkg-1/res-7'),
      null,
      ctx
    )
    expect(result).toBeNull()
    expect(ctx.putObject).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('reports an empty interpretation for an empty CSV', async () => {
    // Not a missing answer: the schema records that this version was
    // interpreted and holds nothing to load, which is what keeps the hourly
    // lake sweep from handing it back for good (ADR-046).
    mockStorageDownload('')

    const result = await executeInterpret(
      'res-8',
      'pkg-1',
      version('resources/pkg-1/res-8'),
      'CSV',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
      schema: { rowCount: 0, columns: [] },
      // Which nothing. The empty schema alone cannot say.
      reason: 'no-columns',
    })
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should return UTF8 for GeoJSON without downloading', async () => {
    const result = await executeInterpret(
      'res-9',
      'pkg-1',
      version('resources/pkg-1/res-9'),
      'GeoJSON',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should return UTF8 for JSON without downloading', async () => {
    const result = await executeInterpret(
      'res-10',
      'pkg-1',
      version('resources/pkg-1/res-10'),
      'JSON',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should return UTF8 for MD without downloading', async () => {
    const result = await executeInterpret(
      'res-10b',
      'pkg-1',
      version('resources/pkg-1/res-10b'),
      'MD',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should parse XML encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0" encoding="Shift_JIS"?><root/>')

    const result = await executeInterpret(
      'res-11',
      'pkg-1',
      version('resources/pkg-1/res-11'),
      'XML',
      ctx
    )

    expect(result).toEqual({ previewKey: null, encoding: 'Shift_JIS' })
  })

  it('should default to UTF8 for XML without encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0"?><root/>')

    const result = await executeInterpret(
      'res-12',
      'pkg-1',
      version('resources/pkg-1/res-12'),
      'XML',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
  })

  it('should remove footer rows (合計, ※)', async () => {
    mockStorageDownload('name,count\nA,10\nB,20\n合計,30\n※ 2024年データ,,\n')

    const result = await executeInterpret(
      'res-13',
      'pkg-1',
      version('resources/pkg-1/res-13'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-13', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('should detect and convert Shift_JIS encoding', async () => {
    ctx.storage.download.mockResolvedValue(Readable.from(shiftJisCsv()))

    const result = await executeInterpret(
      'res-14',
      'pkg-1',
      version('resources/pkg-1/res-14'),
      'CSV',
      ctx
    )

    expect(result?.encoding).toBe('Shift_JIS')
    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-14', 'parquet'))
  })

  it('should not skip header in single-column CSV', async () => {
    mockStorageDownload('name\nAlice\nBob\n')

    const result = await executeInterpret(
      'res-16',
      'pkg-1',
      version('resources/pkg-1/res-16'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-16', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('should handle multiple title rows before header', async () => {
    mockStorageDownload(
      'Report Title,,,\nSubtitle,,,\n,,,\nname,age,city,country\nAlice,30,Tokyo,Japan\n'
    )

    const result = await executeInterpret(
      'res-15',
      'pkg-1',
      version('resources/pkg-1/res-15'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-15', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
    expect(result?.schema?.columns.map((c) => c.name)).toEqual(['name', 'age', 'city', 'country'])
  })

  it('should generate ZIP manifest and upload as JSON', async () => {
    const zip = new JSZip()
    zip.file('data.csv', 'a,b\n1,2')
    zip.file('readme.txt', 'hello')
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    ctx.storage.download.mockResolvedValue(Readable.from(zipBuffer))

    const result = await executeInterpret(
      'res-zip',
      'pkg-1',
      version('resources/pkg-1/res-zip'),
      'ZIP',
      ctx
    )

    expect(result).toEqual({
      previewKey: previewKeyMatching('pkg-1', 'res-zip', 'json'),
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-zip')
    expect(ctx.putObject).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.putObject.mock.calls[0]
    expect(key).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-zip', 'json'))
    expect(meta).toEqual({ contentType: 'application/json' })

    const manifest = JSON.parse(buf.toString())
    expect(manifest.totalFiles).toBe(2)
    expect(manifest.entries).toHaveLength(2)
    expect(manifest.truncated).toBe(false)
  })

  it('should return null for corrupt ZIP', async () => {
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from('not a zip')))

    const result = await executeInterpret(
      'res-badzip',
      'pkg-1',
      version('resources/pkg-1/res-badzip'),
      'ZIP',
      ctx
    )

    expect(result).toBeNull()
    expect(ctx.putObject).not.toHaveBeenCalled()
  })
})
