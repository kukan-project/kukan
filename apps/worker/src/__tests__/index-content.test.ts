import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { executeIndexContent } from '../pipeline/steps/index-content'
import type { PipelineContext } from '../pipeline/types'
import type { ExtractResult } from '../pipeline/steps/extract'
import type { ContentDoc } from '@kukan/search-adapter'

function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf)
}

function createMockCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    getResource: vi.fn().mockResolvedValue({
      id: 'res-1',
      packageId: 'pkg-1',
      name: 'data.csv',
      description: 'Test resource',
      url: 'data.csv',
      urlType: 'upload',
      format: 'CSV',
      hash: null,
    }),
    updateResourceHashAndSize: vi.fn(),
    acquireFetchSlot: vi.fn(),
    indexContent: vi.fn(),
    updatePipelineMetadata: vi.fn(),
    ...overrides,
  }
}

const defaultExtractResult: ExtractResult = {
  previewKey: 'previews/pkg-1/res-1.parquet',
  encoding: 'UTF8',
}

describe('executeIndexContent', () => {
  describe('format classification', () => {
    it('should return null for PDF (not indexable)', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)
      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it('should return null for XLSX (not indexable)', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'XLSX', null, ctx)
      expect(result).toBeNull()
    })

    it('should return null for null format', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', null, null, ctx)
      expect(result).toBeNull()
    })

    it('should classify CSV as tabular', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('a,b\n1,2')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'CSV',
        defaultExtractResult,
        ctx
      )
      expect(result?.contentType).toBe('tabular')
    })

    it('should classify TXT as text', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('hello')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )
      expect(result?.contentType).toBe('text')
    })

    it('should classify JSON as text', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('{"a":1}')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'JSON',
        defaultExtractResult,
        ctx
      )
      expect(result?.contentType).toBe('text')
    })
  })

  describe('text extraction', () => {
    it('should extract and index CSV content', async () => {
      const csvContent = 'name,value\nTokyo,13960000\nOsaka,8839000'
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from(csvContent)))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'CSV',
        defaultExtractResult,
        ctx
      )

      expect(result).not.toBeNull()
      expect(result!.contentIndexed).toBe(true)
      expect(result!.contentTruncated).toBe(false)

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).toBe(csvContent)
      expect(indexedDoc.packageId).toBe('pkg-1')
      expect(indexedDoc.id).toBe('res-1')
    })

    it('should strip HTML tags for HTML format', async () => {
      const html = '<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>'
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from(html)))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'HTML',
        defaultExtractResult,
        ctx
      )

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).not.toContain('<')
      expect(indexedDoc.extractedText).toContain('Title')
      expect(indexedDoc.extractedText).toContain('Hello')
      expect(indexedDoc.extractedText).toContain('world')
      expect(result!.contentType).toBe('text')
    })

    it('should use encoding from extract result', async () => {
      // Shift_JIS encoded "東京"
      const sjisBuffer = Buffer.from([0x93, 0x8c, 0x8b, 0x9e])
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(sjisBuffer))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'CSV',
        { previewKey: null, encoding: 'SJIS' },
        ctx
      )

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).toBe('東京')
      expect(result!.contentIndexed).toBe(true)
    })
  })

  describe('ZIP manifest', () => {
    it('should extract file paths from ZIP manifest', async () => {
      const manifest = {
        totalFiles: 3,
        entries: [
          { path: 'data/population.csv' },
          { path: 'data/income.csv' },
          { path: 'README.md' },
        ],
      }
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(
        bufferToStream(Buffer.from(JSON.stringify(manifest)))
      )

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'ZIP',
        { previewKey: 'previews/pkg-1/res-1.json', encoding: 'UTF8' },
        ctx
      )

      expect(result!.contentType).toBe('manifest')
      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).toBe('data/population.csv\ndata/income.csv\nREADME.md')
    })

    it('should return null for ZIP without preview key', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'ZIP',
        { previewKey: null, encoding: 'UTF8' },
        ctx
      )
      expect(result).toBeNull()
    })
  })

  describe('truncation', () => {
    it('should truncate content exceeding MAX_CONTENT_INDEX_SIZE', async () => {
      // Create content larger than 100KB
      const largeContent = 'A'.repeat(200 * 1024)
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from(largeContent)))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )

      expect(result!.contentTruncated).toBe(true)
      expect(result!.contentOriginalSize).toBe(200 * 1024)
      expect(result!.contentIndexedSize).toBeLessThanOrEqual(100 * 1024)
    })

    it('should not truncate content within limit', async () => {
      const smallContent = 'Hello World'
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from(smallContent)))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )

      expect(result!.contentTruncated).toBe(false)
      expect(result!.contentOriginalSize).toBe(result!.contentIndexedSize)
    })

    it('should handle multi-byte truncation correctly', async () => {
      // Japanese text where truncation might split a multi-byte char
      const japaneseText = '東京都'.repeat(50000) // ~450KB in UTF-8
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from(japaneseText)))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )

      expect(result!.contentTruncated).toBe(true)
      // Verify no replacement characters from bad truncation
      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).not.toContain('\uFFFD')
    })
  })

  describe('resource metadata', () => {
    it('should return null when resource is not found', async () => {
      const ctx = createMockCtx({ getResource: vi.fn().mockResolvedValue(null) })
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('test')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )
      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it('should include resourceId and packageId in content doc', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('a,b')))

      await executeIndexContent('res-1', 'pkg-1', 'key', 'CSV', defaultExtractResult, ctx)

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.id).toBe('res-1')
      expect(indexedDoc.packageId).toBe('pkg-1')
      expect(indexedDoc.contentType).toBe('tabular')
    })
  })
})
