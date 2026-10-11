import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { DocumentTextBlock, Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ValidationError } from '@kukan/shared'
import {
  materialKind,
  loadMaterial,
  type MaterialArtifacts,
} from '../../../services/suggest/materials'
import { readDocumentTextHead } from '../../../services/document-text'
import { SUGGEST_TEXT_HEAD_BYTES } from '../../../config'
import { artifactOf } from '../../test-helpers/document-text'

const query = vi.fn()
vi.mock('../../../services/query/query-service', () => ({
  QueryService: class {
    query = query
  },
}))

const settled: MaterialArtifacts = {
  pipelineStatus: 'complete',
  previewKey: 'previews/p.parquet',
  pipelineMetadata: { schema: { columns: [] }, textHeadKey: 'previews/head.txt' },
  liveStorageKey: 'resources/r',
}

describe('materialKind', () => {
  it('does not decide whether the run that wrote the artifacts has finished', () => {
    // The pipeline's own Summarize step reads the artifacts of the run it is
    // part of, and at that moment the row still says `processing`. Deciding it
    // here made that caller see no material for every table, text file and
    // archive — the caller that wants a settled row asks for one itself.
    for (const pipelineStatus of ['complete', 'processing', 'queued', null]) {
      expect(materialKind({ id: 'r', format: 'CSV' }, { ...settled, pipelineStatus })).toBe(
        'tabular'
      )
    }
  })

  it('routes each format to what holds its material', () => {
    expect(materialKind({ id: 'r', format: 'TXT' }, settled)).toBe('text')
    expect(materialKind({ id: 'r', format: 'PDF' }, settled)).toBe('document')
    expect(materialKind({ id: 'r', format: 'ZIP' }, settled)).toBe('zip')
    expect(materialKind({ id: 'r', format: 'RDF' }, settled)).toBeNull()
  })

  it('reads a document from its text artifact, where it has any text', () => {
    const pdf = { id: 'r', format: 'PDF' }
    const artifact = { documentTextKey: 'previews/r.text.ndjson.zst' }
    const withMetadata = (pipelineMetadata: unknown) => ({ ...settled, pipelineMetadata })
    expect(materialKind(pdf, withMetadata({ ...artifact, documentTextBytes: 10 }))).toBe('document')
    // A scan: the artifact holds its pages and no text
    expect(materialKind(pdf, withMetadata({ ...artifact, documentTextBytes: 0 }))).toBeNull()
    // The artifact is what this run wrote, so a text head left beside it is not read
    expect(
      materialKind(pdf, withMetadata({ ...artifact, documentTextBytes: 0, textHeadKey: 'h.txt' }))
    ).toBeNull()
    // A purge cleared the key and left the bytes
    expect(materialKind(pdf, withMetadata({ documentTextBytes: 10 }))).toBeNull()
    // A run from before the bytes were recorded: its text head is read
    expect(materialKind(pdf, withMetadata({ ...artifact, textHeadKey: 'h.txt' }))).toBe('document')
  })

  it('reads a JSON as a table where its records made one, as text otherwise (ADR-063 §決定 10)', () => {
    const json = { id: 'r', format: 'JSON' }
    const schema = {
      rowCount: 2,
      columns: [{ name: 'id', type: 'string', nullable: false, nullCount: 0 }],
    }
    expect(materialKind(json, { ...settled, pipelineMetadata: { schema } })).toBe('tabular')
    expect(
      materialKind({ ...json, format: 'GeoJSON' }, { ...settled, pipelineMetadata: { schema } })
    ).toBe('tabular')
    // A configuration object: no table, so the live text as before
    expect(
      materialKind(json, { ...settled, pipelineMetadata: { schema: { rowCount: 0, columns: [] } } })
    ).toBe('text')
    expect(materialKind(json, settled)).toBe('text')
  })

  it('needs the artifact, not just the format', () => {
    expect(
      materialKind({ id: 'r', format: 'PDF' }, { ...settled, pipelineMetadata: {} })
    ).toBeNull()
    expect(materialKind({ id: 'r', format: 'ZIP' }, { ...settled, previewKey: null })).toBeNull()
    expect(
      materialKind({ id: 'r', format: 'TXT' }, { ...settled, liveStorageKey: null })
    ).toBeNull()
  })
})

describe('loadMaterial, tabular', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
  const deps = { db: {} as Database, storage: {} as StorageAdapter, log }
  const schema = {
    columns: [{ name: 'pref', type: 'string', nullable: false, nullCount: 0 }],
    rowCount: 3,
  }
  const artifacts = { ...settled, pipelineMetadata: { schema } }

  beforeEach(() => {
    query.mockReset()
    vi.mocked(log.warn).mockReset()
  })

  it('keeps the schema when the rows cannot be read', async () => {
    // A CSV whose interpretation wrote a schema but no preview Parquet. The
    // query path refuses it, and that refusal used to reach the pipeline step,
    // which failed its job and had the queue retry the same package for ever.
    query.mockRejectedValue(new ValidationError('Resource is not queryable'))

    const material = await loadMaterial('tabular', { id: 'r', format: 'CSV' }, artifacts, deps)

    expect(material.schema).toEqual(schema)
    expect(material.sampleRows).toBeNull()
    expect(log.warn).toHaveBeenCalled()
  })

  it('reads the rows when the preview is there', async () => {
    query.mockResolvedValue({ rows: [{ pref: '青森県' }] })

    const material = await loadMaterial('tabular', { id: 'r', format: 'CSV' }, artifacts, deps)

    expect(material.sampleRows).toEqual([{ pref: '青森県' }])
  })
})

describe('loadMaterial, document', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

  async function headOf(blocks: DocumentTextBlock[]) {
    const source = Readable.from([artifactOf(blocks)])
    const storage = { download: vi.fn(async () => source) } as unknown as StorageAdapter
    const material = await loadMaterial(
      'document',
      { id: 'r', format: 'PDF' },
      {
        ...settled,
        pipelineMetadata: { documentTextKey: 'previews/r.text.ndjson.zst', documentTextBytes: 1 },
      },
      { db: {} as Database, storage, log }
    )
    return { head: material.textHead!, source }
  }

  it('cuts the head from the artifact, a newline between the blocks with text', async () => {
    const { head } = await headOf([
      { loc: { page: 1 }, text: '第1章\n概要' },
      { loc: { page: 2 }, text: '', unreadable: 'no-text' },
      { loc: { page: 3 }, text: '本文' },
    ])

    expect(head).toBe('第1章\n概要\n本文')
  })

  it('stops at the budget without splitting a character, and reads no further', async () => {
    const page = (n: number) => ({ loc: { page: n }, text: 'あ'.repeat(1000) })
    const { head, source } = await headOf(Array.from({ length: 30 }, (_, i) => page(i + 1)))

    const bytes = Buffer.byteLength(head, 'utf-8')
    expect(bytes).toBeLessThanOrEqual(SUGGEST_TEXT_HEAD_BYTES)
    expect(bytes).toBeGreaterThan(SUGGEST_TEXT_HEAD_BYTES - 4)
    expect(head).not.toContain('\uFFFD')
    expect(source.destroyed).toBe(true)
  })

  it('counts no newline before the first block', async () => {
    const storage = {
      download: async () =>
        Readable.from([
          artifactOf([
            { loc: { page: 1 }, text: 'abc' },
            { loc: { page: 2 }, text: 'def' },
          ]),
        ]),
    } as unknown as StorageAdapter

    // "abc" and the newline after it fill the 4 bytes
    expect(await readDocumentTextHead(storage, 'k', 4)).toBe('abc\n')
  })
})
