import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'
import JSZip from 'jszip'
import type { PipelineContext } from '../pipeline/types'
import { executeExtract } from '../pipeline/steps/extract'

function createMockCtx() {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
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
      previewKey: 'previews/pkg-1/res-1.parquet',
      encoding: 'ASCII',
    })
    expect(ctx.storage.upload).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.storage.upload.mock.calls[0]
    expect(key).toBe('previews/pkg-1/res-1.parquet')
    expect(meta).toEqual({ contentType: 'application/vnd.apache.parquet' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('should handle title row skipping in Parquet output', async () => {
    mockStorageDownload('Title Row,,,\n\nname,age,city\nAlice,30,Tokyo\n')

    const result = await executeExtract('res-2', 'pkg-1', 'resources/pkg-1/res-2', 'CSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-2.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should extract TSV data', async () => {
    mockStorageDownload('name\tage\nAlice\t30\n')

    const result = await executeExtract('res-3', 'pkg-1', 'resources/pkg-1/res-3', 'TSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-3.parquet')
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
    expect(result?.previewKey).toBe('previews/pkg-1/res-4.parquet')
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

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for GeoJSON without downloading', async () => {
    const result = await executeExtract('res-9', 'pkg-1', 'resources/pkg-1/res-9', 'GeoJSON', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for JSON without downloading', async () => {
    const result = await executeExtract('res-10', 'pkg-1', 'resources/pkg-1/res-10', 'JSON', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.download).not.toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for MD without downloading', async () => {
    const result = await executeExtract('res-10b', 'pkg-1', 'resources/pkg-1/res-10b', 'MD', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should parse XML encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0" encoding="Shift_JIS"?><root/>')

    const result = await executeExtract('res-11', 'pkg-1', 'resources/pkg-1/res-11', 'XML', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'SJIS' })
  })

  it('should default to UTF8 for XML without encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0"?><root/>')

    const result = await executeExtract('res-12', 'pkg-1', 'resources/pkg-1/res-12', 'XML', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
  })

  it('should remove footer rows (合計, ※)', async () => {
    mockStorageDownload('name,count\nA,10\nB,20\n合計,30\n※ 2024年データ,,\n')

    const result = await executeExtract('res-13', 'pkg-1', 'resources/pkg-1/res-13', 'CSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-13.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should detect and convert Shift_JIS encoding', async () => {
    const text = '名前,年齢\n太郎,30\n花子,25\n'
    const Encoding = (await import('encoding-japanese')).default
    const sjisArray = Encoding.convert(Encoding.stringToCode(text), {
      to: 'SJIS',
      from: 'UNICODE',
    })
    const sjisBuf = Buffer.from(sjisArray)
    ctx.storage.download.mockResolvedValue(Readable.from(sjisBuf))

    const result = await executeExtract('res-14', 'pkg-1', 'resources/pkg-1/res-14', 'CSV', ctx)

    expect(result?.encoding).toBe('SJIS')
    expect(result?.previewKey).toBe('previews/pkg-1/res-14.parquet')
  })

  it('should not skip header in single-column CSV', async () => {
    mockStorageDownload('name\nAlice\nBob\n')

    const result = await executeExtract('res-16', 'pkg-1', 'resources/pkg-1/res-16', 'CSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-16.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should handle multiple title rows before header', async () => {
    mockStorageDownload(
      'Report Title,,,\nSubtitle,,,\n,,,\nname,age,city,country\nAlice,30,Tokyo,Japan\n'
    )

    const result = await executeExtract('res-15', 'pkg-1', 'resources/pkg-1/res-15', 'CSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-15.parquet')
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
      previewKey: 'previews/pkg-1/res-zip.json',
      encoding: 'UTF8',
    })
    expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-zip')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.storage.upload.mock.calls[0]
    expect(key).toBe('previews/pkg-1/res-zip.json')
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
