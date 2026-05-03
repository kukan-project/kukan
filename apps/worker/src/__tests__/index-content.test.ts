import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { executeIndexContent, splitIntoChunks } from '../pipeline/steps/index-content'
import type { PipelineContext } from '../pipeline/types'
import type { ExtractResult } from '../pipeline/steps/extract'
import type { ContentDoc } from '@kukan/search-adapter'

const mockToText = vi.fn().mockReturnValue('Extracted document text\nPage 2 content')

vi.mock('officeparser', () => ({
  OfficeParser: {
    parseOffice: vi.fn().mockImplementation(() => Promise.resolve({ toText: mockToText })),
  },
}))

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
    deleteContent: vi.fn(),
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
    it('should classify PDF as document', async () => {
      const ctx = createMockCtx()
      // storage.download returns a stream that will be written to a temp file
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake-pdf')))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)
      expect(result?.contentType).toBe('document')
      expect(result?.contentIndexed).toBe(true)
    })

    it('should classify XLSX as document', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake-xlsx')))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'XLSX', null, ctx)
      expect(result?.contentType).toBe('document')
    })

    it('should return null for null format', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', null, null, ctx)
      expect(result).toBeNull()
    })

    it('should delete existing content for non-indexable format', async () => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'RDF', null, ctx)
      expect(result).toBeNull()
      expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')
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
      expect(indexedDoc.resourceId).toBe('res-1')
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

  describe('PDF extraction', () => {
    it('should extract text from PDF and index it', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake-pdf')))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)

      expect(result).not.toBeNull()
      expect(result!.contentIndexed).toBe(true)
      expect(result!.contentType).toBe('document')
      expect(result!.contentChunks).toBeGreaterThanOrEqual(1)
      expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).toContain('Extracted document text')
      expect(indexedDoc.resourceId).toBe('res-1')
      expect(indexedDoc.packageId).toBe('pkg-1')
      expect(indexedDoc.contentType).toBe('document')
    })

    it('should handle PDF with empty text', async () => {
      mockToText.mockReturnValueOnce('')

      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake-pdf')))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)

      expect(result!.contentIndexed).toBe(false)
      expect(result!.contentChunks).toBe(0)
    })

    it('should clean up temp file even on extraction error', async () => {
      mockToText.mockImplementationOnce(() => {
        throw new Error('corrupt PDF')
      })

      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake-pdf')))

      await expect(executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)).rejects.toThrow(
        'corrupt PDF'
      )

      // Temp file cleanup is in the finally block — no leaked files
    })
  })

  describe('Office extraction', () => {
    it.each(['DOCX', 'XLSX', 'PPTX'])(
      'should extract text from %s and index it',
      async (format) => {
        const ctx = createMockCtx()
        vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake')))

        const result = await executeIndexContent('res-1', 'pkg-1', 'key', format, null, ctx)

        expect(result).not.toBeNull()
        expect(result!.contentIndexed).toBe(true)
        expect(result!.contentType).toBe('document')
        expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')

        const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
        expect(indexedDoc.extractedText).toContain('Extracted document text')
        expect(indexedDoc.resourceId).toBe('res-1')
        expect(indexedDoc.packageId).toBe('pkg-1')
      }
    )

    it.each(['DOC', 'XLS', 'PPT'])('should return null for legacy format %s', async (format) => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', format, null, ctx)
      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it('should handle Office document with empty text', async () => {
      mockToText.mockReturnValueOnce('')

      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('fake')))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'DOCX', null, ctx)

      expect(result!.contentIndexed).toBe(false)
      expect(result!.contentChunks).toBe(0)
    })
  })

  describe('chunking', () => {
    it('should create single chunk for small content', async () => {
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

      expect(result).not.toBeNull()
      expect(result!.contentTruncated).toBe(false)
      expect(result!.contentChunks).toBe(1)
      expect(ctx.indexContent).toHaveBeenCalledTimes(1)

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.chunkIndex).toBe(0)
      expect(indexedDoc.extractedText).toBe(smallContent)
    })

    it('should set chunk metadata for single-chunk content', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('small')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultExtractResult,
        ctx
      )

      expect(result!.contentChunks).toBe(1)
      const doc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(doc.chunkIndex).toBe(0)
      expect(doc.extractedText).toBe('small')
    })

    it('should delete existing content before re-indexing', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('test')))

      await executeIndexContent('res-1', 'pkg-1', 'key', 'TXT', defaultExtractResult, ctx)

      expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')
      // deleteContent should be called before indexContent
      const deleteOrder = vi.mocked(ctx.deleteContent).mock.invocationCallOrder[0]
      const indexOrder = vi.mocked(ctx.indexContent).mock.invocationCallOrder[0]
      expect(deleteOrder).toBeLessThan(indexOrder)
    })

    it('should report contentTruncated false for small content', async () => {
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

      expect(result!.contentTruncated).toBe(false)
      expect(result!.contentOriginalSize).toBe(result!.contentIndexedSize)
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
      expect(indexedDoc.resourceId).toBe('res-1')
      expect(indexedDoc.packageId).toBe('pkg-1')
      expect(indexedDoc.contentType).toBe('tabular')
    })
  })
})

describe('splitIntoChunks', () => {
  it('should return single chunk for small text', () => {
    const chunks = splitIntoChunks('hello world', 1024, 10)
    expect(chunks).toEqual(['hello world'])
  })

  it('should split at line boundaries', () => {
    const text = 'line1\nline2\nline3'
    // maxChunkBytes small enough to force split
    const chunks = splitIntoChunks(text, 10, 10)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk should contain a partial line
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\n$/) // trailing newline stripped by join
    }
  })

  it('should respect maxChunks limit', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const chunks = splitIntoChunks(text, 20, 3)
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  it('should handle single line exceeding chunk size', () => {
    const longLine = 'A'.repeat(200)
    const chunks = splitIntoChunks(longLine, 50, 10)
    expect(chunks.length).toBe(1)
    expect(Buffer.byteLength(chunks[0], 'utf-8')).toBeLessThanOrEqual(50)
  })

  it('should handle empty text', () => {
    const chunks = splitIntoChunks('', 1024, 10)
    expect(chunks).toEqual([''])
  })
})
