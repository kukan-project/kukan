/**
 * The half of the key check that reads content (spec §6.4), against real
 * PostgreSQL with the DuckLake call stubbed.
 *
 * **The cases the route's own tests deliberately avoid.** Those prove no
 * session is opened where none is needed; these prove the one that is opened
 * reads the live preview, and that what it answers reaches the response.
 *
 * A file of its own because the module mock is hoisted over the whole file.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { RequestAbandonedError } from '@kukan/shared'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { keyFault, lakeStorageUrl, openLakeSession } from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { ResourceVersionService } from '../../services/resource-version-service'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return { ...actual, openLakeSession: vi.fn(), keyFault: vi.fn() }
})

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string
let resourceId: string

/** A live version whose columns carry no recorded uniqueness, so a check reads. */
async function liveVersion(columns: string[]) {
  const storageKey = getStorageKey(packageId, resourceId, 'v1')
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    storageKey,
    size: 100,
    hash: 'sha256:v1',
    origin: 'upload',
    schema: {
      rowCount: 2,
      columns: columns.map((name) => ({
        name,
        type: 'string' as const,
        nullable: false,
        nullCount: 0,
        distinctCount: 2,
      })),
    },
  })
  await db.update(resource).set({ storageKey, hash: 'sha256:v1' })
}

async function withPreview(sourceHash: string | null) {
  await db.insert(resourcePipeline).values({
    resourceId,
    previewKey: 'previews/pkg/res.parquet',
    metadata: sourceHash === null ? {} : { sourceHash },
  })
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-key-check', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id

  vi.clearAllMocks()
  vi.mocked(openLakeSession).mockResolvedValue({
    run: async () => {},
    rows: async () => [],
    interrupt: () => {},
    close: async () => {},
  } as unknown as LakeSession)
  vi.mocked(keyFault).mockResolvedValue(null)
})

afterAll(async () => {
  await closeTestDb()
  vi.restoreAllMocks()
})

describe('checking a key against the content', () => {
  const check = (key: string[]) =>
    service.checkPrimaryKey(
      resourceId,
      { primaryKey: key as [string, ...string[]] },
      {
        lake: unreachableLake,
      }
    )

  it('reads the live preview, and answers what the ingest would', async () => {
    // Through the ingest's own function, over the interpretation of the bytes
    // the next version will be made of.
    await liveVersion(['order', 'line'])
    await withPreview('sha256:v1')
    vi.mocked(keyFault).mockResolvedValue('key-not-unique')

    expect(await check(['order', 'line'])).toEqual({
      checked: true,
      primaryKey: ['order', 'line'],
      fault: 'key-not-unique',
    })
    expect(keyFault).toHaveBeenCalledWith(expect.anything(), {
      parquetUrl: lakeStorageUrl(unreachableLake, 'previews/pkg/res.parquet'),
      keys: ['order', 'line'],
    })
  })

  it('will not answer off a preview that describes other bytes', async () => {
    // A run whose Interpret failed leaves the previous content's preview in
    // place — the state `schemaDescribesLiveContent` exists to catch. Answering
    // "unique" off it is answering about bytes the ingest will never read.
    await liveVersion(['order', 'line'])
    await withPreview('sha256:something-else')

    expect(await check(['order', 'line'])).toEqual({
      checked: false,
      primaryKey: ['order', 'line'],
      reason: 'preview-stale',
    })
    expect(keyFault).not.toHaveBeenCalled()
  })

  it('stops before scanning when the caller leaves during the session setup', async () => {
    // The bounds have to cover the setup, not just the scan: a picker firing on
    // every keystroke abandons requests mid-flight, and a scan started after
    // that holds the one slot every query shares (see `scanLake`).
    await liveVersion(['order', 'line'])
    await withPreview('sha256:v1')
    let open!: () => void
    vi.mocked(openLakeSession).mockReturnValue(
      new Promise((resolve) => {
        open = () => resolve({ interrupt: () => {}, close: async () => {} } as LakeSession)
      })
    )
    const abort = new AbortController()

    const running = service.checkPrimaryKey(
      resourceId,
      { primaryKey: ['order', 'line'] },
      { lake: unreachableLake, signal: abort.signal }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    abort.abort()

    await expect(running).rejects.toBeInstanceOf(RequestAbandonedError)
    expect(keyFault).not.toHaveBeenCalled()
    open()
  })

  it('does not read at all for a single column the version already answered for', async () => {
    await db.insert(resourceVersion).values({
      resourceId,
      version: 1,
      storageKey: getStorageKey(packageId, resourceId, 'v1'),
      size: 100,
      hash: 'sha256:v1',
      origin: 'upload',
      schema: {
        rowCount: 2,
        columns: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            nullCount: 0,
            distinctCount: 2,
            unique: true,
          },
        ],
      },
    })
    await db
      .update(resource)
      .set({ storageKey: getStorageKey(packageId, resourceId, 'v1'), hash: 'sha256:v1' })
    await withPreview('sha256:v1')

    expect(await check(['id'])).toMatchObject({ checked: true, fault: null })
    expect(openLakeSession).not.toHaveBeenCalled()
  })
})
