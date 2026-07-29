import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'
import JSZip from 'jszip'
import type { PipelineContext } from '../pipeline/types'
import { executeExtract } from '../pipeline/steps/extract'

/**
 * Preview keys carry a per-run UUID (ADR-043 layer 2: the object a reader
 * resolved must never be rewritten), so they are matched by shape.
 */
const PREVIEW_KEY_RE = (pkg: string, res: string, ext: string) =>
  new RegExp(`^previews/${pkg}/${res}\\.[0-9a-f-]{36}\\.${ext}$`)

const previewKeyMatching = (pkg: string, res: string, ext: string) =>
  expect.stringMatching(PREVIEW_KEY_RE(pkg, res, ext))

function createMockCtx() {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    getResource: vi.fn(),
    publishContent: vi.fn().mockResolvedValue(true),
    acquireFetchSlot: vi.fn(),
    indexContent: vi.fn(),
    deleteContent: vi.fn(),
  } satisfies PipelineContext
}

describe('executeExtract', () => {
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(() => {
    ctx = createMockCtx()
  })

  function mockStorageDownload(content: string) {
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from(content)))
  }

  it('should extract CSV from Storage and upload Parquet', async () => {
    mockStorageDownload('name,age\nAlice,30\nBob,25\n')

    const result = await executeExtract('res-1', 'pkg-1', 'resources/pkg-1/res-1', 'CSV', ctx)

    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-1')
    expect(result).toEqual({
      previewKey: previewKeyMatching('pkg-1', 'res-1', 'parquet'),
      encoding: expect.stringMatching(/^(ASCII|ISO-8859-1)$/),
      schema: {
        rowCount: 2,
        columns: [
          { name: 'name', type: 'string', nullable: false, nullCount: 0 },
          {
            name: 'age',
            type: 'integer',
            nullable: false,
            nullCount: 0,
            stats: { min: '25', max: '30' },
          },
        ],
      },
    })
    expect(ctx.storage.upload).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.storage.upload.mock.calls[0]
    // Unique per run so a later run cannot rewrite it (ADR-043 layer 2).
    expect(key).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-1', 'parquet'))
    expect(meta).toEqual({ contentType: 'application/vnd.apache.parquet' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('should handle title row skipping in Parquet output', async () => {
    mockStorageDownload('Title Row,,,\n\nname,age,city\nAlice,30,Tokyo\n')

    const result = await executeExtract('res-2', 'pkg-1', 'resources/pkg-1/res-2', 'CSV', ctx)

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-2', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should extract TSV data', async () => {
    mockStorageDownload('name\tage\nAlice\t30\n')

    const result = await executeExtract('res-3', 'pkg-1', 'resources/pkg-1/res-3', 'TSV', ctx)

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-3', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should store all rows without truncation', async () => {
    const lines = ['name,value']
    for (let i = 0; i < 300; i++) {
      lines.push(`row-${i},${i}`)
    }
    mockStorageDownload(lines.join('\n') + '\n')

    const result = await executeExtract('res-4', 'pkg-1', 'resources/pkg-1/res-4', 'CSV', ctx)

    // Parquet stores all rows (no 200-row limit)
    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-4', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should detect encoding for TXT without Parquet generation', async () => {
    mockStorageDownload('Hello, world!')

    const result = await executeExtract('res-5', 'pkg-1', 'resources/pkg-1/res-5', 'TXT', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'ASCII' })
    expect(ctx.storage.download).toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return null for non-text formats', async () => {
    const result = await executeExtract('res-6', 'pkg-1', 'resources/pkg-1/res-6', 'PDF', ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should return null for null format', async () => {
    const result = await executeExtract('res-7', 'pkg-1', 'resources/pkg-1/res-7', null, ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should return encoding with null previewKey for empty CSV', async () => {
    mockStorageDownload('')

    const result = await executeExtract('res-8', 'pkg-1', 'resources/pkg-1/res-8', 'CSV', ctx)

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for GeoJSON without downloading', async () => {
    const result = await executeExtract('res-9', 'pkg-1', 'resources/pkg-1/res-9', 'GeoJSON', ctx)

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for JSON without downloading', async () => {
    const result = await executeExtract('res-10', 'pkg-1', 'resources/pkg-1/res-10', 'JSON', ctx)

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for MD without downloading', async () => {
    const result = await executeExtract('res-10b', 'pkg-1', 'resources/pkg-1/res-10b', 'MD', ctx)

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should parse XML encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0" encoding="Shift_JIS"?><root/>')

    const result = await executeExtract('res-11', 'pkg-1', 'resources/pkg-1/res-11', 'XML', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'Shift_JIS' })
  })

  it('should default to UTF8 for XML without encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0"?><root/>')

    const result = await executeExtract('res-12', 'pkg-1', 'resources/pkg-1/res-12', 'XML', ctx)

    expect(result).toEqual({
      previewKey: null,
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
  })

  it('should remove footer rows (合計, ※)', async () => {
    mockStorageDownload('name,count\nA,10\nB,20\n合計,30\n※ 2024年データ,,\n')

    const result = await executeExtract('res-13', 'pkg-1', 'resources/pkg-1/res-13', 'CSV', ctx)

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-13', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
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

    const result = await executeExtract('res-14', 'pkg-1', 'resources/pkg-1/res-14', 'CSV', ctx)

    expect(result?.encoding).toBe('Shift_JIS')
    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-14', 'parquet'))
  })

  it('should not skip header in single-column CSV', async () => {
    mockStorageDownload('name\nAlice\nBob\n')

    const result = await executeExtract('res-16', 'pkg-1', 'resources/pkg-1/res-16', 'CSV', ctx)

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-16', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should handle multiple title rows before header', async () => {
    mockStorageDownload(
      'Report Title,,,\nSubtitle,,,\n,,,\nname,age,city,country\nAlice,30,Tokyo,Japan\n'
    )

    const result = await executeExtract('res-15', 'pkg-1', 'resources/pkg-1/res-15', 'CSV', ctx)

    expect(result?.previewKey).toMatch(PREVIEW_KEY_RE('pkg-1', 'res-15', 'parquet'))
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should generate ZIP manifest and upload as JSON', async () => {
    const zip = new JSZip()
    zip.file('data.csv', 'a,b\n1,2')
    zip.file('readme.txt', 'hello')
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    ctx.storage.download.mockResolvedValue(Readable.from(zipBuffer))

    const result = await executeExtract('res-zip', 'pkg-1', 'resources/pkg-1/res-zip', 'ZIP', ctx)

    expect(result).toEqual({
      previewKey: previewKeyMatching('pkg-1', 'res-zip', 'json'),
      encoding: expect.stringMatching(/^(UTF-?8|ASCII|ISO-8859-1)$/),
    })
    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-zip')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.storage.upload.mock.calls[0]
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
      'resources/pkg-1/res-badzip',
      'ZIP',
      ctx
    )

    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })
})
