import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ValidationError } from '@kukan/shared'
import {
  materialKind,
  loadMaterial,
  type MaterialArtifacts,
} from '../../services/suggest/materials'

const query = vi.fn()
vi.mock('../../services/query-service', () => ({
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
