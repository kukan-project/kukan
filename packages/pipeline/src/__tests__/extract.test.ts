import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'
import { parseBuffer } from '../parsers/csv-parser'
import { parquetWriteBuffer } from 'hyparquet-writer'
import type { PipelineContext } from '../types'

// Mock runWorker to run the conversion synchronously in-process (no actual worker thread)
vi.mock('../run-worker.js', () => ({
  runWorker: vi.fn(async (_path: string, input: { csvBuffer: Buffer; rowGroupSize: number }) => {
    const buf = Buffer.from(input.csvBuffer)
    const extracted = parseBuffer(buf)

    if (extracted.headers.length === 0) {
      return { parquetBuffer: null, encoding: extracted.encoding }
    }

    const columnData = extracted.headers.map((header, colIndex) => ({
      name: header || `column_${colIndex}`,
      data: extracted.rows.map((row) => row[colIndex] ?? ''),
      type: 'STRING' as const,
    }))

    const parquetBuf = parquetWriteBuffer({ columnData, rowGroupSize: input.rowGroupSize })
    return { parquetBuffer: Buffer.from(parquetBuf), encoding: extracted.encoding }
  }),
}))

// Import after mock setup
const { extractStep } = await import('../steps/extract')

function createMockCtx() {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    search: {
      index: vi.fn(),
    },
    getResource: vi.fn(),
    updateResourceHashAndSize: vi.fn(),
    getPackageForIndex: vi.fn(),
  } satisfies PipelineContext
}

describe('extractStep', () => {
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(() => {
    ctx = createMockCtx()
  })

  function mockStorageDownload(content: string) {
    ctx.storage.download.mockResolvedValue(Readable.from(Buffer.from(content)))
  }

  it('should extract CSV from Storage and upload Parquet', async () => {
    mockStorageDownload('name,age\nAlice,30\nBob,25\n')

    const result = await extractStep('res-1', 'pkg-1', 'resources/pkg-1/res-1', 'CSV', ctx)

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

    const result = await extractStep('res-2', 'pkg-1', 'resources/pkg-1/res-2', 'CSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-2.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should extract TSV data', async () => {
    mockStorageDownload('name\tage\nAlice\t30\n')

    const result = await extractStep('res-3', 'pkg-1', 'resources/pkg-1/res-3', 'TSV', ctx)

    expect(result?.previewKey).toBe('previews/pkg-1/res-3.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should store all rows without truncation', async () => {
    const lines = ['name,value']
    for (let i = 0; i < 300; i++) {
      lines.push(`row-${i},${i}`)
    }
    mockStorageDownload(lines.join('\n') + '\n')

    const result = await extractStep('res-4', 'pkg-1', 'resources/pkg-1/res-4', 'CSV', ctx)

    // Parquet stores all rows (no 200-row limit)
    expect(result?.previewKey).toBe('previews/pkg-1/res-4.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should detect encoding for TXT without Parquet generation', async () => {
    mockStorageDownload('Hello, world!')

    const result = await extractStep('res-5', 'pkg-1', 'resources/pkg-1/res-5', 'TXT', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'ASCII' })
    expect(ctx.storage.download).toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return null for non-text formats', async () => {
    const result = await extractStep('res-6', 'pkg-1', 'resources/pkg-1/res-6', 'PDF', ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should return null for null format', async () => {
    const result = await extractStep('res-7', 'pkg-1', 'resources/pkg-1/res-7', null, ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
    expect(ctx.storage.download).not.toHaveBeenCalled()
  })

  it('should return encoding with null previewKey for empty CSV', async () => {
    mockStorageDownload('')

    const result = await extractStep('res-8', 'pkg-1', 'resources/pkg-1/res-8', 'CSV', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for GeoJSON without Parquet generation', async () => {
    mockStorageDownload('{"type":"FeatureCollection","features":[]}')

    const result = await extractStep('res-9', 'pkg-1', 'resources/pkg-1/res-9', 'GeoJSON', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.download).toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return UTF8 for JSON without Parquet generation', async () => {
    mockStorageDownload('{"key":"value"}')

    const result = await extractStep('res-10', 'pkg-1', 'resources/pkg-1/res-10', 'JSON', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(ctx.storage.download).toHaveBeenCalled()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should parse XML encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0" encoding="Shift_JIS"?><root/>')

    const result = await extractStep('res-11', 'pkg-1', 'resources/pkg-1/res-11', 'XML', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'SJIS' })
  })

  it('should default to UTF8 for XML without encoding declaration', async () => {
    mockStorageDownload('<?xml version="1.0"?><root/>')

    const result = await extractStep('res-12', 'pkg-1', 'resources/pkg-1/res-12', 'XML', ctx)

    expect(result).toEqual({ previewKey: null, encoding: 'UTF8' })
  })
})
