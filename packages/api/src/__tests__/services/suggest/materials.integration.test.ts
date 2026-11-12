/**
 * The sample rows of a private table, as the abstract reads them (ADR-053).
 *
 * The pipeline writes abstracts for private packages, and read as an anonymous
 * caller their rows were refused: the abstract came from the schema alone.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { unlink } from 'node:fs/promises'
import { createLogger } from '@kukan/shared'
import { createTestApp, mockStorage } from '../../test-helpers/test-app'
import { writeParquet } from '../../test-helpers/parquet'
import { createQueryableResource, QUERYABLE_SCHEMA } from '../../test-helpers/queryable-resource'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../../test-helpers/test-db'
import { loadMaterial, PIPELINE_READER } from '../../../services/suggest/materials'

const db = getTestDb()

let fixturePath: string
const storage = { ...mockStorage, getSignedUrl: async () => fixturePath }
const app = createTestApp(db, { storage })
const deps = { db, storage, log: createLogger({ name: 'test', level: 'silent' }) }

const artifacts = {
  pipelineStatus: 'success',
  previewKey: 'previews/data.parquet',
  pipelineMetadata: { schema: QUERYABLE_SCHEMA },
  liveStorageKey: null,
}

beforeAll(async () => {
  fixturePath = await writeParquet(`SELECT i AS id, 'name' || i AS name FROM range(100) t(i)`)
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await unlink(fixturePath).catch(() => {})
  await closeTestDb()
})

describe('loadMaterial for a private table', () => {
  it('reads sample rows for the pipeline', async () => {
    const id = await createQueryableResource(app, db, { private: true })

    const material = await loadMaterial(
      'tabular',
      { id, format: 'CSV' },
      artifacts,
      deps,
      PIPELINE_READER
    )

    expect(material.sampleRows?.length).toBeGreaterThan(0)
    expect(Object.keys(material.sampleRows![0])).toEqual(['id', 'name'])
  })

  it('still reads none for an anonymous caller', async () => {
    const id = await createQueryableResource(app, db, { private: true })

    const material = await loadMaterial('tabular', { id, format: 'CSV' }, artifacts, deps)

    expect(material.sampleRows).toBeNull()
  })
})
