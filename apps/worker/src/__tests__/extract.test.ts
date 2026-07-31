import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { Readable } from 'stream'
import JSZip from 'jszip'
import { executeExtract } from '../pipeline/steps/extract'
import { MAX_PARQUET_SOURCE_SIZE } from '../config'
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

/** The captured version the step reads (ADR-046); sized under the interpret cap. */
const version = (storageKey: string, size = 1024) => ({ storageKey, size })

describe('executeExtract', () => {
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

    const result = await executeExtract(
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

    const result = await executeExtract(
      'res-2',
      'pkg-1',
      version('resources/pkg-1/res-2'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-2', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('should extract TSV data', async () => {
    mockStorageDownload('name\tage\nAlice\t30\n')

    const result = await executeExtract(
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

    const result = await executeExtract(
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
    let seen: { magic: string; previewKey: string; path: string; leftInDir: string[] } | undefined

    const result = await executeExtract(
      'res-t',
      'pkg-1',
      version('versions/pkg-1/res-t/v1'),
      'CSV',
      ctx,
      {
        onTable: async (parquetPath, previewKey) => {
          // Still there, and a real Parquet: layer 2 loads from here rather
          // than from the preview in storage (ADR-046).
          seen = {
            magic: readFileSync(parquetPath).subarray(0, 4).toString('ascii'),
            previewKey,
            path: parquetPath,
            // And nothing else: the hook waits on a catalog-wide lock, so the
            // source CSV and its transcoded copy must not be held through it.
            leftInDir: readdirSync(dirname(parquetPath)),
          }
        },
      }
    )

    expect(seen?.magic).toBe('PAR1')
    expect(seen?.previewKey).toBe(result!.previewKey)
    expect(seen?.leftInDir).toEqual([basename(seen!.path)])
    // And gone once the step returns — the temp directory belongs to the step.
    expect(existsSync(seen!.path)).toBe(false)
  })

  it('does not hand a table over for a format that produces none', async () => {
    // The gate layer 2 used to apply to the preview key is structural now: the
    // hook simply never fires.
    mockStorageDownload('Hello, world!')
    const onTable = vi.fn()

    await executeExtract('res-u', 'pkg-1', version('versions/pkg-1/res-u/v1'), 'TXT', ctx, {
      onTable,
    })

    expect(onTable).not.toHaveBeenCalled()
  })

  it('labels a CSV too large to interpret without transferring it whole', async () => {
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

    const result = await executeExtract(
      'res-big',
      'pkg-1',
      version('versions/pkg-1/res-big/v1', MAX_PARQUET_SOURCE_SIZE + 1),
      'CSV',
      ctx
    )

    expect(result).toEqual({ previewKey: null, encoding: expect.any(String) })
    expect(ctx.putObject).not.toHaveBeenCalled()
    // Only the encoding sample crossed the wire, not the whole object.
    expect(read).toBeLessThan(CHUNK * CHUNKS)
  })

  it('should detect encoding for TXT without Parquet generation', async () => {
    mockStorageDownload('Hello, world!')

    const result = await executeExtract(
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
    const result = await executeExtract(
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
    const result = await executeExtract(
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

  it('should return encoding with null previewKey for empty CSV', async () => {
    mockStorageDownload('')

    const result = await executeExtract(
      'res-8',
      'pkg-1',
      version('resources/pkg-1/res-8'),
      'CSV',
      ctx
    )

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.putObject).not.toHaveBeenCalled()
  })

  it('should return UTF8 for GeoJSON without downloading', async () => {
    const result = await executeExtract(
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
    const result = await executeExtract(
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
    const result = await executeExtract(
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

    const result = await executeExtract(
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

    const result = await executeExtract(
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

    const result = await executeExtract(
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
    // Real Shift_JIS CSV header: "都道府県コード又は市区町村コード,地域コード,都道府県名,..."
    // followed by data row: "402303,糸島市,2019-05-31,板持,1515,758,757\n"
    const header = Buffer.from([
      0x93, 0x73, 0x93, 0xb9, 0x95, 0x7b, 0x8c, 0xa7, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c,
      0x92, 0x6e, 0x88, 0xe6, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x93, 0x73, 0x93, 0xb9,
      0x95, 0x7b, 0x8c, 0xa7, 0x96, 0xbc, 0x0a,
    ])
    const dataRow = Buffer.from([
      0x34, 0x30, 0x32, 0x33, 0x30, 0x33, 0x2c, 0x8e, 0x85, 0x93, 0x87, 0x8e, 0x73, 0x2c, 0x32,
      0x30, 0x31, 0x39, 0x2d, 0x30, 0x35, 0x2d, 0x33, 0x31, 0x2c, 0x94, 0xc2, 0x8e, 0x9d, 0x2c,
      0x31, 0x35, 0x31, 0x35, 0x2c, 0x37, 0x35, 0x38, 0x2c, 0x37, 0x35, 0x37, 0x0a,
    ])
    const sjisBuf = Buffer.concat([header, ...Array(20).fill(dataRow)])
    ctx.storage.download.mockResolvedValue(Readable.from(sjisBuf))

    const result = await executeExtract(
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

    const result = await executeExtract(
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

    const result = await executeExtract(
      'res-15',
      'pkg-1',
      version('resources/pkg-1/res-15'),
      'CSV',
      ctx
    )

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-15', 'parquet'))
    expect(ctx.putObject).toHaveBeenCalledOnce()
  })

  it('should generate ZIP manifest and upload as JSON', async () => {
    const zip = new JSZip()
    zip.file('data.csv', 'a,b\n1,2')
    zip.file('readme.txt', 'hello')
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    ctx.storage.download.mockResolvedValue(Readable.from(zipBuffer))

    const result = await executeExtract(
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

    const result = await executeExtract(
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
