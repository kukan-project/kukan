import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { executeIndexContent } from '../pipeline/steps/index-content'
import type { InterpretResult } from '../pipeline/steps/interpret'
import {
  createPipelineContextMock,
  type PipelineContextMock,
} from './test-helpers/pipeline-context'
import type { ContentDoc } from '@kukan/search-adapter'
import { DOCUMENT_TEXT_SCHEMA, type DocumentTextBlock } from '@kukan/shared'
import { UNPROFILED_TABLE_HEAD_SIZE } from '@/config'

function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf)
}

/** Where a document's interpretation kept its text, in these tests. */
const DOCUMENT_TEXT = 'previews/pkg-1/res-1.tok.text.ndjson.zst'

/**
 * A document's interpretation, its text artifact holding `blocks` and served
 * from `ctx`'s storage.
 */
function documentInterpreted(
  ctx: PipelineContextMock,
  blocks: DocumentTextBlock[]
): InterpretResult {
  const artifact = zstdCompressSync(
    Buffer.from(
      [{ schema: DOCUMENT_TEXT_SCHEMA }, ...blocks]
        .map((line) => JSON.stringify(line) + '\n')
        .join('')
    )
  )
  vi.mocked(ctx.storage.download).mockImplementation(async () => Readable.from(artifact))
  const texts = blocks.map((b) => b.text).filter(Boolean)
  const bytes = Buffer.byteLength(texts.join('\n'))
  return {
    previewKey: null,
    documentText: {
      key: DOCUMENT_TEXT,
      bytes,
      ...(texts.some((t) => t.trim()) && { textHead: { key: 'previews/head.txt', bytes } }),
    },
  }
}

function createMockCtx(): PipelineContextMock {
  const ctx = createPipelineContextMock()
  ctx.getResource.mockResolvedValue({
    id: 'res-1',
    packageId: 'pkg-1',
    name: 'data.csv',
    description: 'Test resource',
    url: 'data.csv',
    urlType: 'upload',
    format: 'CSV',
    hash: null,
    size: null,
    storageKey: 'resources/pkg-1/res-1',
  })
  ctx.getPackageState.mockResolvedValue('active')
  return ctx
}

const defaultInterpretResult: InterpretResult = {
  previewKey: 'previews/pkg-1/res-1.parquet',
  encoding: 'UTF8',
}

describe('executeIndexContent', () => {
  describe('draft package skip (ADR-039)', () => {
    it('should skip indexing when the package is a draft', async () => {
      const ctx = createMockCtx()
      ctx.getPackageState.mockResolvedValue('draft')

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'CSV', null, ctx)

      expect(result).toBeNull()
      expect(ctx.storage.download).not.toHaveBeenCalled()
      expect(ctx.indexContent).not.toHaveBeenCalled()
      expect(ctx.deleteContent).not.toHaveBeenCalled()
    })

    it('should skip indexing when the package no longer exists', async () => {
      const ctx = createMockCtx()
      ctx.getPackageState.mockResolvedValue(null)

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'CSV', null, ctx)

      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it.each(['deleted', 'purging'] as const)(
      'should skip everything for a %s package even for documents',
      async (state) => {
        const ctx = createMockCtx()
        ctx.getPackageState.mockResolvedValue(state)

        const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)

        expect(result).toBeNull()
        expect(ctx.storage.download).not.toHaveBeenCalled()
        expect(ctx.putObject).not.toHaveBeenCalled()
        expect(ctx.indexContent).not.toHaveBeenCalled()
      }
    )
  })

  describe('format classification', () => {
    it.each(['PDF', 'XLSX'])('should classify %s as document', async (format) => {
      const ctx = createMockCtx()
      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        format,
        documentInterpreted(ctx, [{ loc: {}, text: 'text' }]),
        ctx
      )
      expect(result?.contentType).toBe('document')
      expect(result?.contentIndexed).toBe(true)
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
        defaultInterpretResult,
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
        defaultInterpretResult,
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
        defaultInterpretResult,
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
        defaultInterpretResult,
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
        defaultInterpretResult,
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

  describe('tables by their profile (ADR-063)', () => {
    const artifact = (lines: object[]) =>
      bufferToStream(zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n'))))
    const profiled = (profile: InterpretResult['profile']): InterpretResult => ({
      ...defaultInterpretResult,
      profile,
    })
    const texts = (ctx: PipelineContextMock) =>
      ctx.indexContent.mock.calls.map(([doc]) => (doc as ContentDoc).extractedText)

    it('indexes the values and the sentences, not the file', async () => {
      const ctx = createMockCtx()
      ctx.storage.download.mockResolvedValue(
        artifact([
          { kind: 'value', column: '区分', text: '公園', count: 3, row: 1 },
          { kind: 'value', column: '区分', text: '広場', count: 1, row: 2 },
          { kind: 'value', column: '施設名', text: '東公園', count: 1, row: 1 },
          { kind: 'sentence', column: null, text: '備考: 駐車場あり。', count: 1, row: 1 },
        ])
      )

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'resources/pkg-1/res-1',
        'CSV',
        profiled({ columns: [], key: 'previews/pkg-1/res-1.t.profile.ndjson.zst' }),
        ctx
      )

      expect(ctx.storage.download).toHaveBeenCalledWith('previews/pkg-1/res-1.t.profile.ndjson.zst')
      expect(texts(ctx)).toEqual(['区分: 公園、広場\n施設名: 東公園\n備考: 駐車場あり。'])
      expect(result).toMatchObject({
        contentIndexed: true,
        contentType: 'tabular',
        contentChunks: 1,
      })
    })

    it('fails the step when the artifact download breaks off', async () => {
      const ctx = createMockCtx()
      const compressed = zstdCompressSync(
        Buffer.from('{"kind":"value","column":"区分","text":"公園"}\n')
      )
      const broken = new Readable({
        read() {
          this.push(compressed.subarray(0, 4))
          this.destroy(new Error('connection reset'))
        },
      })
      ctx.storage.download.mockResolvedValue(broken)

      await expect(
        executeIndexContent(
          'res-1',
          'pkg-1',
          'resources/pkg-1/res-1',
          'CSV',
          profiled({ columns: [], key: 'k' }),
          ctx
        )
      ).rejects.toThrow('connection reset')
    })

    it('puts the heading on every short line of a long list of values', async () => {
      const ctx = createMockCtx()
      const names = Array.from({ length: 60 }, (_, i) => `施設${String(i).padStart(4, '0')}`)
      ctx.storage.download.mockResolvedValue(
        artifact(
          names.map((text, i) => ({ kind: 'value', column: '施設名', text, count: 1, row: i + 1 }))
        )
      )

      await executeIndexContent(
        'res-1',
        'pkg-1',
        'resources/pkg-1/res-1',
        'CSV',
        profiled({ columns: [], key: 'k' }),
        ctx
      )

      const lines = texts(ctx).join('\n').split('\n')
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.every((l) => l.startsWith('施設名: '))).toBe(true)
      expect(lines.every((l) => l.length <= '施設名: '.length + 120)).toBe(true)
      expect(lines.flatMap((l) => l.slice('施設名: '.length).split('、'))).toEqual(names)
    })

    it('indexes a table with nothing to list as indexed, with no documents', async () => {
      // Numbers and codes: indexed means the index holds what the content gives it
      const ctx = createMockCtx()

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'resources/pkg-1/res-1',
        'CSV',
        profiled({ columns: [] }),
        ctx
      )

      expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')
      expect(ctx.indexContent).not.toHaveBeenCalled()
      expect(ctx.storage.download).not.toHaveBeenCalled()
      expect(result).toMatchObject({ contentIndexed: true, contentChunks: 0 })
    })

    it('falls back to the contents where the profile could not be made', async () => {
      const ctx = createMockCtx()
      ctx.storage.download.mockResolvedValue(bufferToStream(Buffer.from('a,b\n1,2\n')))

      await executeIndexContent(
        'res-1',
        'pkg-1',
        'resources/pkg-1/res-1',
        'CSV',
        profiled({ columns: [], error: 'Out of Memory' }),
        ctx
      )

      expect(ctx.storage.download).toHaveBeenCalledWith('resources/pkg-1/res-1')
      expect(texts(ctx)).toEqual(['a,b\n1,2'])
    })

    it('indexes only the head of a table the interpretation made nothing of', async () => {
      const ctx = createMockCtx()
      const row = `${'1,'.repeat(499)}1`
      const csv = `${'設問,'.repeat(499)}設問\n${`${row}\n`.repeat(200)}`
      const size = Buffer.byteLength(csv)
      ctx.getResource.mockResolvedValue({ ...(await ctx.getResource('res-1'))!, size })
      ctx.storage.download.mockResolvedValue(bufferToStream(Buffer.from(csv)))

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'CSV', null, ctx)

      const text = texts(ctx).join('\n')
      expect(text.startsWith('設問,')).toBe(true)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(UNPROFILED_TABLE_HEAD_SIZE)
      expect(Buffer.byteLength(text)).toBeGreaterThan(UNPROFILED_TABLE_HEAD_SIZE - 4)
      expect(result).toMatchObject({ contentTruncated: true, contentOriginalSize: size })
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

  describe('documents, from the text their interpretation kept', () => {
    it('indexes the text of the blocks, and none of the rest', async () => {
      const ctx = createMockCtx()
      const interpreted = documentInterpreted(ctx, [
        { loc: { page: 1 }, headings: ['第1章'], text: '本文\n二行目' },
        { loc: { page: 2 }, text: '', unreadable: 'no-text' },
        { loc: { page: 2 }, text: '市域の地図', figure: { ref: '9 0 R' } },
      ])

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', interpreted, ctx)

      expect(ctx.storage.download).toHaveBeenCalledWith(DOCUMENT_TEXT)
      expect(ctx.deleteContent).toHaveBeenCalledWith('res-1')
      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.extractedText).toBe('本文\n二行目\n市域の地図')
      expect(indexedDoc.contentType).toBe('document')
      expect(result).toMatchObject({ contentIndexed: true, contentChunks: 1 })
      // The size of what was extracted, as the interpretation measured it
      expect(result!.contentOriginalSize).toBe(interpreted.documentText!.bytes)
      expect(ctx.putObject).not.toHaveBeenCalled()
    })

    it('leaves what was indexed before for a document with no text', async () => {
      const ctx = createMockCtx()
      const interpreted = documentInterpreted(ctx, [
        { loc: { page: 1 }, text: '', unreadable: 'no-text' },
      ])

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', interpreted, ctx)

      expect(result).toMatchObject({ contentIndexed: false, contentChunks: 0 })
      expect(ctx.deleteContent).not.toHaveBeenCalled()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it('leaves what was indexed before when nothing was interpreted this run', async () => {
      const ctx = createMockCtx()

      expect(await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', null, ctx)).toBeNull()
      expect(ctx.storage.download).not.toHaveBeenCalled()
      expect(ctx.deleteContent).not.toHaveBeenCalled()
    })

    it('does nothing for a draft package (ADR-039), the text being kept already', async () => {
      const ctx = createMockCtx()
      ctx.getPackageState.mockResolvedValue('draft')
      const interpreted = documentInterpreted(ctx, [{ loc: {}, text: 'text' }])

      const result = await executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', interpreted, ctx)

      expect(result).toBeNull()
      expect(ctx.storage.download).not.toHaveBeenCalled()
      expect(ctx.indexContent).not.toHaveBeenCalled()
      expect(ctx.deleteContent).not.toHaveBeenCalled()
    })

    it('fails the step when the artifact download breaks off', async () => {
      const ctx = createMockCtx()
      const interpreted = documentInterpreted(ctx, [{ loc: {}, text: 'text' }])
      const broken = new Readable({ read() {} })
      vi.mocked(ctx.storage.download).mockResolvedValue(broken)
      setImmediate(() => broken.destroy(new Error('connection reset')))

      await expect(
        executeIndexContent('res-1', 'pkg-1', 'key', 'PDF', interpreted, ctx)
      ).rejects.toThrow()
    })

    it.each(['DOC', 'XLS', 'PPT'])('should return null for legacy format %s', async (format) => {
      const ctx = createMockCtx()
      const result = await executeIndexContent('res-1', 'pkg-1', 'key', format, null, ctx)
      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
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
        defaultInterpretResult,
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

    it('waits for the index to refresh on the last chunk only, in order', async () => {
      // A chunk not yet searchable is invisible to the delete-by-query that
      // clears a resource's content, so the step ends on a write that waits
      const line = 'x'.repeat(400 * 1024)
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(
        bufferToStream(Buffer.from([line, line, line].join('\n')))
      )

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultInterpretResult,
        ctx
      )

      expect(result!.contentChunks).toBe(3)
      const calls = vi.mocked(ctx.indexContent).mock.calls
      expect(calls.map(([doc]) => (doc as ContentDoc).chunkIndex)).toEqual([0, 1, 2])
      expect(calls.map(([, options]) => options?.waitForRefresh !== false)).toEqual([
        false,
        false,
        true,
      ])
    })

    it('should set chunk metadata for single-chunk content', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('small')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultInterpretResult,
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

      await executeIndexContent('res-1', 'pkg-1', 'key', 'TXT', defaultInterpretResult, ctx)

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
        defaultInterpretResult,
        ctx
      )

      expect(result!.contentTruncated).toBe(false)
      expect(result!.contentOriginalSize).toBe(result!.contentIndexedSize)
    })
  })

  describe('resource metadata', () => {
    it('should return null when resource is not found', async () => {
      const ctx = createMockCtx()
      ctx.getResource.mockResolvedValue(null)
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('test')))

      const result = await executeIndexContent(
        'res-1',
        'pkg-1',
        'key',
        'TXT',
        defaultInterpretResult,
        ctx
      )
      expect(result).toBeNull()
      expect(ctx.indexContent).not.toHaveBeenCalled()
    })

    it('should include resourceId and packageId in content doc', async () => {
      const ctx = createMockCtx()
      vi.mocked(ctx.storage.download).mockResolvedValue(bufferToStream(Buffer.from('a,b')))

      await executeIndexContent('res-1', 'pkg-1', 'key', 'CSV', defaultInterpretResult, ctx)

      const indexedDoc = vi.mocked(ctx.indexContent).mock.calls[0][0] as ContentDoc
      expect(indexedDoc.resourceId).toBe('res-1')
      expect(indexedDoc.packageId).toBe('pkg-1')
      expect(indexedDoc.contentType).toBe('tabular')
    })
  })
})
