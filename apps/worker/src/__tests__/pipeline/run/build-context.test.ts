import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  insertVersionIfHeld,
  objectAlreadyVersioned,
  objectOwnerIsPurging,
  pendingLakeVersionSource,
  setVersionSchemaIfHeld,
} from '@kukan/api/services/resource-version-service'
import { copyObject, publishLiveContent } from '@kukan/api/services/pipeline/storage-pointer'
import { buildPipelineContext } from '../../../pipeline/run/build-context'

// Mock @kukan/db schema
vi.mock('@kukan/db', () => ({
  resource: {
    id: 'id',
    packageId: 'package_id',
    url: 'url',
    urlType: 'url_type',
    format: 'format',
    hash: 'hash',
    name: 'name',
    description: 'description',
    state: 'state',
  },
  resourcePipeline: {
    resourceId: 'resource_id',
    previewKey: 'preview_key',
    metadata: 'metadata',
    profile: 'profile',
  },
  resourceVersion: {},
  packageTable: {},
}))

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val, type: 'eq' })),
  ne: vi.fn((col, val) => ({ col, val, type: 'ne' })),
  and: vi.fn((...conditions) => ({ conditions, type: 'and' })),
  desc: vi.fn((col) => ({ col, type: 'desc' })),
  sql: Object.assign((strings: TemplateStringsArray) => strings.join(''), { raw: vi.fn() }),
}))

// The statements these issue are pinned by the integration tests; here they
// are the answers the context decides on
vi.mock('@kukan/api/services/resource-version-service', () => ({
  insertVersionIfHeld: vi.fn(),
  setVersionSchemaIfHeld: vi.fn(),
  objectAlreadyVersioned: vi.fn(),
  objectOwnerIsPurging: vi.fn(),
  pendingLakeVersionSource: vi.fn(),
}))
vi.mock('@kukan/api/services/pipeline/storage-pointer', () => ({
  copyObject: vi.fn(),
  publishLiveContent: vi.fn(),
  reserveObject: vi.fn(),
  // Read by the worker's config at import time
  UPLOAD_WRITE_WINDOW_MS: 24 * 60 * 60 * 1000,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Create a mock DB that supports chaining and thenable resolution.
 * Results are consumed in order via callIndex, matching the sequential
 * construction of query chains (even inside Promise.all).
 */
function createMockDb() {
  const results: unknown[][] = []
  let callIndex = 0

  function makeThenable(result: unknown[]) {
    const obj = {
      limit: vi.fn(() => makeThenable(result)),
      orderBy: vi.fn(() => makeThenable(result)),
      for: vi.fn(() => makeThenable(result)),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)),
    }
    return obj
  }

  const self = {
    select: vi.fn(() => self),
    from: vi.fn(() => self),
    innerJoin: vi.fn(() => self),
    where: vi.fn(() => {
      const result = results[callIndex++] ?? []
      return makeThenable(result)
    }),
    limit: vi.fn(() => {
      const result = results[callIndex++] ?? []
      return makeThenable(result)
    }),
    update: vi.fn(() => self),
    set: vi.fn(() => self),
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(self)),
  }

  return {
    db: self as unknown as Parameters<typeof buildPipelineContext>[0],
    addResult: (result: unknown[]) => results.push(result),
  }
}

const mockStorage = {
  upload: vi.fn(),
  download: vi.fn(),
  readUrl: (key: string) => `s3://test/${key}`,
  downloadRange: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  copy: vi.fn(),
  list: vi.fn(),
  deleteByPrefix: vi.fn(),
  deleteMany: vi.fn(),
  head: vi.fn(),
}

describe('buildPipelineContext', () => {
  it('getResource should return resource data for active resource', async () => {
    const { db, addResult } = createMockDb()
    addResult([
      {
        id: 'res-1',
        packageId: 'pkg-1',
        url: 'https://example.com/data.csv',
        urlType: 'api',
        format: 'CSV',
        hash: 'sha256:abc',
      },
    ])

    const ctx = buildPipelineContext(db, mockStorage)
    const res = await ctx.getResource('res-1')

    expect(res).toEqual({
      id: 'res-1',
      packageId: 'pkg-1',
      url: 'https://example.com/data.csv',
      urlType: 'api',
      format: 'CSV',
      hash: 'sha256:abc',
    })
  })

  it('storedInterpretation reads a document only from a run that kept its text', async () => {
    // A Markdown read as text, before it was a document: interpreted again
    const { db, addResult } = createMockDb()
    addResult([
      {
        previewKey: null,
        metadata: { sourceHash: 'h', encoding: 'UTF8' },
        profile: null,
        format: 'MD',
      },
    ])
    expect(await buildPipelineContext(db, mockStorage).storedInterpretation('r', 'h', 1)).toBeNull()

    const kept = createMockDb()
    kept.addResult([
      {
        previewKey: null,
        metadata: { sourceHash: 'h', encoding: 'UTF8', documentTextKey: 'k', documentTextBytes: 3 },
        profile: null,
        format: 'MD',
      },
    ])
    expect(
      await buildPipelineContext(kept.db, mockStorage).storedInterpretation('r', 'h', 1)
    ).toEqual({ previewKey: null, encoding: 'UTF8', documentText: { key: 'k', bytes: 3 } })
  })

  it('getResource should return null when not found', async () => {
    const { db, addResult } = createMockDb()
    addResult([])

    const ctx = buildPipelineContext(db, mockStorage)
    const res = await ctx.getResource('nonexistent')

    expect(res).toBeNull()
  })

  it('should pass storage adapter through', () => {
    const { db } = createMockDb()
    const ctx = buildPipelineContext(db, mockStorage)

    expect(ctx.storage).toBe(mockStorage)
  })

  it('deleteContent should call search.deleteContent when search is provided', async () => {
    const { db } = createMockDb()
    const mockSearch = { deleteContent: vi.fn() }
    const ctx = buildPipelineContext(db, mockStorage, mockSearch as never)

    await ctx.deleteContent('res-1')

    expect(mockSearch.deleteContent).toHaveBeenCalledWith('res-1')
  })

  it('deleteContent should be no-op when search is not provided', async () => {
    const { db } = createMockDb()
    const ctx = buildPipelineContext(db, mockStorage)

    await expect(ctx.deleteContent('res-1')).resolves.toBeUndefined()
  })
})

describe('buildPipelineContext — reads', () => {
  it('getPackageState reads the state, and null for a package that is gone', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ state: 'draft' }])
    addResult([])
    const ctx = buildPipelineContext(db, mockStorage)

    expect(await ctx.getPackageState('pkg-1')).toBe('draft')
    expect(await ctx.getPackageState('pkg-2')).toBeNull()
  })

  it('indexContent hands the document to search, and is a no-op without it', async () => {
    const { db } = createMockDb()
    const search = { indexContent: vi.fn() }
    const doc = { resourceId: 'res-1' } as never

    await buildPipelineContext(db, mockStorage, search as never).indexContent(doc, {
      refresh: true,
    } as never)
    await expect(buildPipelineContext(db, mockStorage).indexContent(doc)).resolves.toBeUndefined()

    expect(search.indexContent).toHaveBeenCalledOnce()
    expect(search.indexContent).toHaveBeenCalledWith(doc, { refresh: true })
  })

  it('versionForContent reads a size the table left null as 0', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ version: 2, storageKey: 'k', size: null, format: 'CSV' }])
    addResult([])
    const ctx = buildPipelineContext(db, mockStorage)

    expect(await ctx.versionForContent('r', 'h')).toEqual({
      version: 2,
      storageKey: 'k',
      size: 0,
      format: 'CSV',
    })
    expect(await ctx.versionForContent('r', 'other')).toBeNull()
  })

  it('pendingLakeVersion answers the version, or null where none waits', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ version: 3 }])
    addResult([])
    const ctx = buildPipelineContext(db, mockStorage)

    expect(await ctx.pendingLakeVersion('r', 'h')).toBe(3)
    expect(await ctx.pendingLakeVersion('r', 'h')).toBeNull()
  })

  it('recordVersionSchema spells an absent claim and reason as null', async () => {
    const { db } = createMockDb()
    const schema = { columns: [], rowCount: 0 }

    await buildPipelineContext(db, mockStorage).recordVersionSchema({
      resourceId: 'r',
      version: 1,
      schema,
    })

    expect(setVersionSchemaIfHeld).toHaveBeenCalledWith(db, null, {
      resourceId: 'r',
      version: 1,
      schema,
      noTableReason: null,
    })
  })
})

describe('buildPipelineContext — derivativesDescribe', () => {
  const lake = { config: {} as never, queue: { enqueue: vi.fn() } }

  /** The pipeline row's answer, with or without a lake to ask about. */
  async function describes(row: Record<string, unknown> | null, withLake = false) {
    const { db, addResult } = createMockDb()
    addResult(row ? [row] : [])
    return buildPipelineContext(
      db,
      mockStorage,
      undefined,
      withLake ? lake : undefined
    ).derivativesDescribe('r', 'h', 2)
  }

  const indexed = { sourceHash: 'h', sourceVersion: 2, contentIndexed: true }

  it('holds for a preview made from these bytes, for this version, and indexed', async () => {
    expect(await describes({ previewKey: 'p', metadata: indexed })).toBe(true)
    // A document's text stands in for the preview
    expect(
      await describes({ previewKey: null, metadata: { ...indexed, documentTextKey: 't' } })
    ).toBe(true)
    // A row from before the version was recorded is not taken to be another's
    expect(
      await describes({ previewKey: 'p', metadata: { sourceHash: 'h', contentIndexed: true } })
    ).toBe(true)
  })

  it('does not hold where any one of them is missing', async () => {
    expect(await describes(null)).toBe(false)
    expect(await describes({ previewKey: null, metadata: indexed })).toBe(false)
    expect(await describes({ previewKey: 'p', metadata: { ...indexed, sourceHash: 'x' } })).toBe(
      false
    )
    expect(await describes({ previewKey: 'p', metadata: { ...indexed, sourceVersion: 1 } })).toBe(
      false
    )
    expect(
      await describes({ previewKey: 'p', metadata: { ...indexed, contentIndexed: false } })
    ).toBe(false)
  })

  it('does not hold, with a lake, while the version still waits for its ingest', async () => {
    vi.mocked(pendingLakeVersionSource).mockResolvedValueOnce({
      storageKey: 'k',
      format: 'CSV',
      size: 1,
    })
    expect(await describes({ previewKey: 'p', metadata: indexed }, true)).toBe(false)

    vi.mocked(pendingLakeVersionSource).mockResolvedValueOnce(null)
    expect(await describes({ previewKey: 'p', metadata: indexed }, true)).toBe(true)
    expect(pendingLakeVersionSource).toHaveBeenLastCalledWith(expect.anything(), {
      resourceId: 'r',
      version: 2,
    })
  })
})

describe('buildPipelineContext — storedInterpretation', () => {
  const column = { name: 'a', type: 'string', nullable: false, nullCount: 0 }
  const tableMeta = {
    sourceHash: 'h',
    sourceVersion: 1,
    encoding: 'UTF8',
    schema: { columns: [column], rowCount: 1 },
  }

  async function stored(row: Record<string, unknown> | null) {
    const { db, addResult } = createMockDb()
    addResult(row ? [row] : [])
    return buildPipelineContext(db, mockStorage).storedInterpretation('r', 'h', 1)
  }

  it('reads nothing from a row of other bytes or of another version', async () => {
    expect(await stored(null)).toBeNull()
    const row = { previewKey: 'p', profile: null, format: 'TXT' }
    expect(await stored({ ...row, metadata: { sourceHash: 'x', encoding: 'UTF8' } })).toBeNull()
    expect(
      await stored({ ...row, metadata: { sourceHash: 'h', sourceVersion: 2, encoding: 'UTF8' } })
    ).toBeNull()
  })

  it('reads nothing from a row that kept no preview, no text and no encoding', async () => {
    expect(
      await stored({
        previewKey: null,
        metadata: { sourceHash: 'h' },
        profile: null,
        format: 'ZIP',
      })
    ).toBeNull()
  })

  it('takes a text head without its byte count for no text at all', async () => {
    expect(
      await stored({
        previewKey: null,
        metadata: { sourceHash: 'h', documentTextKey: 'k' },
        profile: null,
        format: 'PDF',
      })
    ).toBeNull()
  })

  it('reads a table only once its profile was kept', async () => {
    const row = { previewKey: 'p', metadata: tableMeta, format: 'CSV' }
    expect(await stored({ ...row, profile: null })).toBeNull()

    const profile = { columns: [] }
    expect(await stored({ ...row, profile })).toEqual({
      previewKey: 'p',
      encoding: 'UTF8',
      profile,
    })
  })

  it('reads a CSV that made no table by how it was read alone', async () => {
    expect(
      await stored({
        previewKey: null,
        metadata: { ...tableMeta, schema: { columns: [], rowCount: 0 } },
        profile: null,
        format: 'CSV',
      })
    ).toEqual({ previewKey: null, encoding: 'UTF8' })
  })
})

describe('buildPipelineContext — createVersion', () => {
  const claim = { token: 'run-1' } as never
  const request = {
    resourceId: 'res-1',
    packageId: 'pkg-1',
    currentStorageKey: 'resources/pkg-1/res-1.a',
    contentHash: 'sha256:new',
    contentSize: 10,
    claim,
  }
  const live = {
    urlType: 'upload',
    storageKey: request.currentStorageKey,
    format: 'CSV',
    columnSettings: null,
  }

  /** The resource, the highest version, then the newest active one. */
  function versionDb(res: unknown, max: unknown, active: unknown, txOwner?: unknown) {
    const { db, addResult } = createMockDb()
    addResult(res ? [res] : [])
    addResult(max ? [max] : [])
    addResult(active ? [active] : [])
    if (txOwner !== undefined) addResult(txOwner ? [txOwner] : [])
    return db
  }

  beforeEach(() => {
    vi.mocked(objectOwnerIsPurging).mockResolvedValue(false)
    vi.mocked(objectAlreadyVersioned).mockResolvedValue(false)
    vi.mocked(insertVersionIfHeld).mockResolvedValue(true as never)
    vi.mocked(publishLiveContent).mockResolvedValue(true)
  })

  it('files the live object itself as the first version', async () => {
    const db = versionDb(live, null, null)

    expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
      created: true,
      version: 1,
    })
    expect(insertVersionIfHeld).toHaveBeenCalledWith(db, claim, {
      resourceId: 'res-1',
      version: 1,
      size: 10,
      hash: 'sha256:new',
      origin: 'upload',
      schema: null,
      storageKey: request.currentStorageKey,
    })
    expect(copyObject).not.toHaveBeenCalled()
  })

  it('creates nothing where the run lost its claim at the insert', async () => {
    vi.mocked(insertVersionIfHeld).mockResolvedValue(false as never)
    const db = versionDb(
      live,
      { version: 1 },
      { hash: 'sha256:old', format: 'CSV', keyColumns: null }
    )

    expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
      created: false,
    })
  })

  it('creates nothing for bytes the newest active version already holds', async () => {
    const db = versionDb(
      live,
      { version: 3 },
      { hash: 'sha256:new', format: 'CSV', keyColumns: null }
    )

    expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
      created: false,
    })
    expect(insertVersionIfHeld).not.toHaveBeenCalled()
  })

  it('creates nothing for a resource that is no longer there', async () => {
    const db = versionDb(null, null, null)

    expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
      created: false,
    })
    expect(insertVersionIfHeld).not.toHaveBeenCalled()
  })

  describe('over an object a version already owns', () => {
    beforeEach(() => {
      vi.mocked(objectAlreadyVersioned).mockResolvedValue(true)
    })
    const active = { hash: 'sha256:new', format: 'TSV', keyColumns: null }

    it('copies it to a key of its own and moves live there with the row', async () => {
      // Same bytes read as another format: a version of its own
      const db = versionDb(live, { version: 4 }, active, { state: 'active' })

      expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
        created: true,
        version: 5,
      })
      const versionKey = vi.mocked(copyObject).mock.calls[0][3]
      expect(versionKey).toMatch(/^resources\/pkg-1\/res-1\./)
      expect(versionKey).not.toBe(request.currentStorageKey)
      expect(insertVersionIfHeld).toHaveBeenCalledWith(
        db,
        claim,
        expect.objectContaining({ version: 5, storageKey: versionKey })
      )
      expect(publishLiveContent).toHaveBeenCalledWith(db, 'res-1', {
        key: versionKey,
        previousKey: request.currentStorageKey,
        hash: 'sha256:new',
        size: 10,
        previousHash: 'sha256:new',
        claim,
      })
    })

    it('creates nothing where the owner was claimed for purging after the gate', async () => {
      const db = versionDb(live, { version: 4 }, active, { state: 'purging' })

      expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
        created: false,
      })
      expect(insertVersionIfHeld).not.toHaveBeenCalled()
    })

    it('creates nothing where the claim went before the insert', async () => {
      vi.mocked(insertVersionIfHeld).mockResolvedValue(false as never)
      const db = versionDb(live, { version: 4 }, active, { state: 'active' })

      expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
        created: false,
      })
      expect(publishLiveContent).not.toHaveBeenCalled()
    })

    it('creates nothing where the pointer moved before it could be published', async () => {
      vi.mocked(publishLiveContent).mockResolvedValue(false)
      const db = versionDb(live, { version: 4 }, active, { state: 'active' })

      expect(await buildPipelineContext(db, mockStorage).createVersion(request)).toEqual({
        created: false,
      })
    })

    it('lets any other failure through', async () => {
      vi.mocked(publishLiveContent).mockRejectedValue(new Error('connection reset'))
      const db = versionDb(live, { version: 4 }, active, null)

      await expect(buildPipelineContext(db, mockStorage).createVersion(request)).rejects.toThrow(
        'connection reset'
      )
    })
  })
})
