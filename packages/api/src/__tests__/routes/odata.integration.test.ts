import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { resource as resourceTable, resourcePipeline, resourceVersion } from '@kukan/db'
import type { ResourceSchema } from '@kukan/shared'
import { createTestApp, mockStorage, testEnv } from '../test-helpers/test-app'
import { writeParquet } from '../test-helpers/parquet'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { ODATA_MAX_PAGE_BYTES, ODATA_MAX_PAGE_ROWS, ODATA_QUEUE_MAX } from '../../config'
import { PINNED_PAGE_MAX_AGE_S } from '@kukan/shared'
import { capacity } from '../../services/odata/capacity'
import { recordMissingRowGroups } from '../../services/odata/row-group-backfill'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { maxRowBytes, rowsWithinByteBudget } from '../../services/odata/page-budget'

const db = getTestDb()

// Four Parquet fixtures behind one mock storage: a small table for most of the
// feed, one a row past the page size for the paging assertions, one whose rows
// are wide enough that the byte budget ends a page first, and one whose
// integers run past what a JS number holds exactly. The preview key names
// which, so nothing has to recognise it from a prefix.
type Fixture = 'small' | 'large' | 'wide' | 'wide-int'
/**
 * Where each fixture sits on disk. The feed reads the location the adapter
 * names — `s3://…` in a deployment, a path here, which is the same code path
 * minus the credentials (ADR-055). There is no download to fall back to.
 */
const fixturePaths = new Map<string, string>()
const fixtureStorage = {
  ...mockStorage,
  readUrl: (key: string) => fixturePaths.get(key.split('/')[1]) ?? '/nonexistent.parquet',
}
const app = createTestApp(db, { storage: fixtureStorage })

const ROWS = 12
const WIDE_ROWS = 60

/**
 * Each fixture's shape, in one place: what `beforeAll` writes, and what the
 * resource row says about it. `bytesPerRow` is what the feed's row-size estimate
 * divides — the wide table's rows are ~195 KB, the rest are a handful of bytes.
 */
const FIXTURE: Record<Fixture, { rows: number; bytesPerRow: number }> = {
  small: { rows: ROWS, bytesPerRow: 40 },
  large: { rows: ODATA_MAX_PAGE_ROWS + 1, bytesPerRow: 40 },
  wide: { rows: WIDE_ROWS, bytesPerRow: 195_000 },
  'wide-int': { rows: 1, bytesPerRow: 40 },
}
const WIDE_SCHEMA: ResourceSchema = {
  columns: [
    { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
    { name: 'name', type: 'string', nullable: false, nullCount: 0 },
  ],
  rowCount: WIDE_ROWS,
}
const SCHEMA: ResourceSchema = {
  columns: [
    { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
    { name: 'name', type: 'string', nullable: false, nullCount: 0 },
    // A Japanese heading passes as an EDM identifier as it stands; a bracketed
    // one does not, which is the split Step 1 is drawn along (ADR-055).
    { name: '人口', type: 'float', nullable: true, nullCount: 1 },
    { name: 'at', type: 'timestamp', nullable: true, nullCount: 0 },
  ],
  rowCount: ROWS,
}

/**
 * {@link SCHEMA} with the counts and bounds that let `id` be the key (ADR-046):
 * distinct in every row, and within the integers a JSON number holds exactly.
 */
const KEYED_SCHEMA: ResourceSchema = {
  ...SCHEMA,
  columns: SCHEMA.columns.map((c) =>
    c.name === 'id'
      ? { ...c, nullCount: 0, distinctCount: ROWS, stats: { min: '0', max: String(ROWS - 1) } }
      : c
  ),
}

/**
 * A table wide enough that a page is bounded by bytes before rows — in
 * Japanese, because that is where the budget can be got wrong: a character is
 * one UTF-16 unit and three bytes, so a page measured by string length would
 * be three times the size it reads as.
 */
const makeWideParquet = (rows: number) =>
  writeParquet(
    `SELECT i AS id, repeat('東京都港区', 13000) AS name FROM range(${rows}) t(i)`,
    'odata-wide'
  )

const makeParquet = (rows: number) =>
  writeParquet(
    `SELECT i AS id,
            'name' || i AS name,
            CASE WHEN i = 0 THEN NULL ELSE i * 1.5 END AS "人口",
            TIMESTAMP '2024-01-02 03:04:05' + INTERVAL (i) DAY AS at
     FROM range(${rows}) t(i)`,
    'odata'
  )

let testOrgId: string | undefined

beforeAll(async () => {
  fixturePaths.set('small', await makeParquet(FIXTURE.small.rows))
  fixturePaths.set('large', await makeParquet(FIXTURE.large.rows))
  // ~195 KB per row: a handful of rows is past the byte budget
  fixturePaths.set('wide', await makeWideParquet(FIXTURE.wide.rows))
  fixturePaths.set(
    'wide-int',
    await writeParquet(
      `SELECT 9007199254740993::BIGINT AS id, 'name0' AS name, NULL::DOUBLE AS "人口",
              TIMESTAMP '2024-01-02 03:04:05' AS at`,
      'odata-wide-int'
    )
  )
}, 60_000)

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  testOrgId = undefined
})

afterAll(async () => {
  await closeTestDb()
  for (const path of fixturePaths.values()) await unlink(path).catch(() => {})
})

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-org-odata' }),
  })
  testOrgId = (await res.json()).id
  return testOrgId
}

async function createResource(opts?: {
  private?: boolean
  schema?: ResourceSchema | null
  /** Which Parquet the preview key points at; the small table by default. */
  fixture?: Fixture
  primaryKey?: string[]
  /** The key a version of this content was taken into layer 2 under. */
  ingestedKey?: string[]
  /** A newer version over the same bytes that has not reached layer 2. */
  reinterpreted?: boolean
  /** The live content's size; null for a resource that never recorded one. */
  size?: number | null
  /** Rows per row group the preview recorded; omitted for an older preview. */
  rowGroupRows?: number
}) {
  const orgId = await ensureTestOrg()
  const pkgRes = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `odata-pkg-${randomUUID().slice(0, 8)}`,
      ownerOrg: orgId,
      private: opts?.private ?? false,
    }),
  })
  const pkg = await pkgRes.json()
  const resRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'data.csv', format: 'CSV' }),
  })
  const resource = await resRes.json()

  // Passing null is the resource whose size was never recorded, which is paged
  // as if its rows were the widest its groups could hold.
  const shape = FIXTURE[opts?.fixture ?? 'small']
  const size = opts?.size === undefined ? shape.rows * shape.bytesPerRow : opts.size

  await db
    .update(resourceTable)
    .set({
      hash: 'sha256:live',
      size,
      ...(opts?.primaryKey ? { columnSettings: { primaryKey: opts.primaryKey } } : {}),
    })
    .where(eq(resourceTable.id, resource.id))
  if (opts?.ingestedKey) {
    await db.insert(resourceVersion).values({
      resourceId: resource.id,
      version: 1,
      storageKey: `versions/${resource.id}`,
      origin: 'upload',
      hash: 'sha256:live',
      ducklakeSnapshotId: 7,
      lakeKeyColumns: opts.ingestedKey,
    })
  }
  if (opts?.reinterpreted) {
    await db.insert(resourceVersion).values({
      resourceId: resource.id,
      version: 2,
      storageKey: `versions/${resource.id}-reread`,
      origin: 'upload',
      hash: 'sha256:live',
    })
  }
  // The large fixture is a page and one row: say so here rather than at each
  // caller, where a forgotten patch is a silently wrong row count.
  const base =
    opts?.schema !== undefined ? opts.schema : opts?.fixture === 'wide' ? WIDE_SCHEMA : SCHEMA
  const schema = opts?.fixture === 'large' && base ? { ...base, rowCount: shape.rows } : base
  await db.insert(resourcePipeline).values({
    resourceId: resource.id,
    status: 'success',
    previewKey: `preview/${opts?.fixture ?? 'small'}/${resource.id}.parquet`,
    metadata: {
      encoding: 'utf-8',
      sourceHash: 'sha256:live',
      ...(opts?.rowGroupRows ? { rowGroupRows: opts.rowGroupRows } : {}),
      ...(schema ? { schema } : {}),
    },
  })
  return resource.id as string
}

const base = (id: string) => `/odata/v1/resources/${id}`

describe('GET /odata/v1/resources/:id', () => {
  it('serves a service document naming the one entity set', async () => {
    const id = await createResource()
    const res = await app.request(base(id))
    expect(res.status).toBe(200)
    expect(res.headers.get('OData-Version')).toBe('4.0')
    const body = await res.json()
    expect(body['@odata.context']).toMatch(new RegExp(`${id}/\\$metadata$`))
    expect(body.value).toEqual([{ name: 'Rows', kind: 'EntitySet', url: 'Rows' }])
  })

  it('answers an id that is not a UUID as not found, not as a server error', async () => {
    // A public, unauthenticated path: a scanned URL must not log as a fault.
    for (const path of ['/odata/v1/resources/not-a-uuid', '/odata/v1/resources/x/Rows']) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect((await res.json()).error.code).toBeDefined()
    }
  })

  it('serves it at the trailing slash a client appends to the service root', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/`)
    expect(res.status).toBe(200)
    expect((await res.json()).value).toEqual([{ name: 'Rows', kind: 'EntitySet', url: 'Rows' }])
  })

  it('404s for a resource with no table', async () => {
    const id = await createResource({ schema: null })
    expect((await app.request(base(id))).status).toBe(404)
  })

  it('404s for a private resource, even to a signed-in sysadmin', async () => {
    // v1 has no authenticated route into the feed (ADR-055 §5), so the answer
    // does not depend on who is asking.
    const id = await createResource({ private: true })
    const res = await app.request(base(id))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('501s when a column name is not an EDM identifier', async () => {
    const id = await createResource({
      schema: {
        columns: [{ name: '人口（人）', type: 'integer', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
    })
    const res = await app.request(base(id))
    expect(res.status).toBe(501)
    expect((await res.json()).error.code).toBe('NOT_IMPLEMENTED')
  })
})

describe('GET /odata/v1/resources/:id/$metadata', () => {
  it('declares the key and every column', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/$metadata`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/xml')
    const xml = await res.text()
    expect(xml).toContain('<Key><PropertyRef Name="RowId"/></Key>')
    expect(xml).toContain('<Property Name="人口" Type="Edm.Double" Nullable="true"/>')
    expect(xml).toContain('<Property Name="at" Type="Edm.DateTimeOffset" Nullable="true"/>')
  })

  it("revalidates $count too, which is the table's own number", async () => {
    // Held for a minute it is the old table's count beside the new table's
    // rows — the same pairing, in the one response that is just a number.
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows/$count`)
    expect(res.headers.get('Cache-Control')).toBe('public, no-cache')
    const etag = res.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(await res.text()).toBe(String(ROWS))

    const again = await app.request(`${base(id)}/Rows/$count`, {
      headers: { 'If-None-Match': etag! },
    })
    expect(again.status).toBe(304)
  })

  it('never lets $metadata go stale, because a client holds it for the extract', async () => {
    // A CSDL 60 seconds old against rows read now is a client combining two
    // versions, with nothing in either response to say so.
    const id = await createResource()
    const res = await app.request(`${base(id)}/$metadata`)
    expect(res.headers.get('Cache-Control')).toBe('public, no-cache')
    expect(res.headers.get('ETag')).toBeTruthy()
  })

  it("names the publisher's primary key as the key, and adds no column for it", async () => {
    const id = await createResource({ schema: KEYED_SCHEMA, primaryKey: ['id'] })
    const xml = await (await app.request(`${base(id)}/$metadata`)).text()
    expect(xml).toContain('<Key><PropertyRef Name="id"/></Key>')
    // Nothing synthetic is declared, and the key's own column is non-nullable
    expect(xml).not.toContain('RowId')
    expect(xml).toContain('<Property Name="id" Type="Edm.Int64" Nullable="false"/>')

    const body = await (await app.request(`${base(id)}/Rows`)).json()
    expect(body.value[0]).not.toHaveProperty('RowId')
    expect(body.value[0].id).toBe(0)
  })

  it('takes a composite key the version was ingested under', async () => {
    // The frozen counts cannot answer for a combination; the ingest checked
    // this version's own rows and recorded the key it used (spec §6.6).
    const id = await createResource({
      schema: KEYED_SCHEMA,
      primaryKey: ['id', 'name'],
      ingestedKey: ['id', 'name'],
    })
    const xml = await (await app.request(`${base(id)}/$metadata`)).text()
    expect(xml).toContain('<Key><PropertyRef Name="id"/><PropertyRef Name="name"/></Key>')
    expect(xml).not.toContain('RowId')

    const body = await (await app.request(`${base(id)}/Rows`)).json()
    expect(body.value[0]).not.toHaveProperty('RowId')
  })

  it('falls back where the same key has not reached layer 2', async () => {
    const id = await createResource({ schema: KEYED_SCHEMA, primaryKey: ['id', 'name'] })
    const xml = await (await app.request(`${base(id)}/$metadata`)).text()
    expect(xml).toContain('<Key><PropertyRef Name="RowId"/></Key>')
  })

  it('does not take a verdict from an older version over the same bytes', async () => {
    // Re-interpreting unchanged bytes makes a new version under the same hash
    // (ADR-046 §3). Until that one is taken in, the key is unchecked against
    // the rows now being served, however the previous reading of them went.
    const id = await createResource({
      schema: KEYED_SCHEMA,
      primaryKey: ['id', 'name'],
      ingestedKey: ['id', 'name'],
      reinterpreted: true,
    })
    const xml = await (await app.request(`${base(id)}/$metadata`)).text()
    expect(xml).toContain('<Key><PropertyRef Name="RowId"/></Key>')
  })
})

describe('GET /odata/v1/resources/:id/Rows', () => {
  it('returns rows keyed by position, typed as declared', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body['@odata.context']).toMatch(/\$metadata#Rows$/)
    expect(body.value).toHaveLength(ROWS)
    expect(body.value[0]).toEqual({
      RowId: 0,
      id: 0,
      name: 'name0',
      人口: null,
      at: '2024-01-02T03:04:05Z',
    })
    expect(body.value[1].人口).toBe(1.5)
    // Not paged: the whole table fits one page
    expect(body['@odata.nextLink']).toBeUndefined()
  })

  it('pages with $top and $skip', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows?$top=2&$skip=3`)
    const body = await res.json()
    expect(body.value.map((r: { RowId: number }) => r.RowId)).toEqual([3, 4])
    expect(body.value[0].name).toBe('name3')
  })

  it('hands back a next link while rows remain', async () => {
    const id = await createResource({ fixture: 'large' })
    const first = await (await app.request(`${base(id)}/Rows`)).json()
    expect(first.value).toHaveLength(ODATA_MAX_PAGE_ROWS)
    expect(first['@odata.nextLink']).toMatch(
      new RegExp(`Rows\\?\\$skip=${ODATA_MAX_PAGE_ROWS}&v=[A-Za-z0-9_-]{12}$`)
    )

    const next = await (await app.request(`${base(id)}/Rows?$skip=${ODATA_MAX_PAGE_ROWS}`)).json()
    expect(next.value).toHaveLength(1)
    expect(next.value[0].RowId).toBe(ODATA_MAX_PAGE_ROWS)
    expect(next['@odata.nextLink']).toBeUndefined()

    // A $top past the page size is still answered a page at a time, and the
    // rest of what was asked for is carried on the next link
    const capped = await (
      await app.request(`${base(id)}/Rows?$top=${ODATA_MAX_PAGE_ROWS + 1}`)
    ).json()
    expect(capped.value).toHaveLength(ODATA_MAX_PAGE_ROWS)
    expect(capped['@odata.nextLink']).toMatch(
      new RegExp(`Rows\\?\\$skip=${ODATA_MAX_PAGE_ROWS}&\\$top=1&v=[A-Za-z0-9_-]{12}$`)
    )
  }, 120_000)

  it('counts on request, and on the $count path', async () => {
    const id = await createResource()
    const body = await (await app.request(`${base(id)}/Rows?$count=true&$top=1`)).json()
    expect(body['@odata.count']).toBe(ROWS)

    const count = await app.request(`${base(id)}/Rows/$count`)
    expect(count.headers.get('Content-Type')).toContain('text/plain')
    expect(await count.text()).toBe(String(ROWS))
  })

  it('refuses a query option it does not apply, rather than ignoring it', async () => {
    const id = await createResource()
    for (const opt of ['$filter=id gt 3', '$orderby=id', '$search=x']) {
      const res = await app.request(`${base(id)}/Rows?${opt}`)
      expect(res.status).toBe(501)
    }
    // $select is tolerated: extra columns are waste, not a wrong answer
    const tolerated = await app.request(`${base(id)}/Rows?$select=id&$top=1`)
    expect(tolerated.status).toBe(200)
    await tolerated.text()
  })

  it('refuses the same options on $count, rather than counting the whole table', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows/$count?$filter=id gt 3`)
    expect(res.status).toBe(501)
    expect(await res.text()).not.toContain(String(ROWS))
  })

  it('cuts a page to the byte budget and links to the rest', async () => {
    const id = await createResource({ fixture: 'wide' })
    const res = await app.request(`${base(id)}/Rows`)
    const text = await res.text()
    // Bytes, not characters: with multibyte rows the two differ threefold
    expect(Buffer.byteLength(text)).toBeLessThan(ODATA_MAX_PAGE_BYTES * 1.1)
    expect(Buffer.byteLength(text)).toBeGreaterThan(text.length)
    const body = JSON.parse(text)
    // Bounded by bytes, not by the row ceiling
    expect(body.value.length).toBeGreaterThan(0)
    expect(body.value.length).toBeLessThan(WIDE_ROWS)
    expect(body['@odata.nextLink']).toMatch(
      new RegExp(`Rows\\?\\$skip=${body.value.length}&v=[A-Za-z0-9_-]{12}$`)
    )
  }, 60_000)

  it('asks the file for its row groups where the interpretation did not, and writes nothing', async () => {
    // A preview from before the figure was recorded: without it, pages have to
    // leave room for two groups, since the boundaries cannot be guessed. The
    // page reads the footer instead — and leaves the row alone, because filling
    // it in belongs to the migration an operator runs (ADR-055 §6).
    const id = await createResource({ fixture: 'large', size: null })
    const body = await (await app.request(`${base(id)}/Rows`)).json()
    // Sized against the group the file turned out to hold — the whole table, as
    // the fixture writer left it in one — rather than the pessimistic assumption
    // an unread footer would force.
    expect(body.value).toHaveLength(rowsWithinByteBudget(maxRowBytes(FIXTURE.large.rows)))

    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    expect((row.metadata as { rowGroupRows?: number }).rowGroupRows).toBeUndefined()
  }, 60_000)

  it('records the figure for every preview that lacks one, once asked to', async () => {
    const id = await createResource({ size: null })
    const result = await recordMissingRowGroups(db, {
      storage: fixtureStorage,
      env: testEnv,
    })
    expect(result.recorded).toBeGreaterThan(0)

    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    // The fixture is one group of its 12 rows, which is what the file says
    expect((row.metadata as { rowGroupRows?: number }).rowGroupRows).toBe(FIXTURE.small.rows)
  }, 60_000)

  it('leaves the figure unrecorded when the re-interpretation cannot be enqueued', async () => {
    // Recording takes the preview out of the candidate query, so a figure that
    // lands without its job strands the table: the prompt clears and running
    // the pass again does not find it. The size puts this one in the band that
    // a 4,096-row group would rescue, which is the only case that enqueues.
    const id = await createResource({
      fixture: 'large',
      size: FIXTURE.large.rows * 500,
      schema: { columns: WIDE_SCHEMA.columns, rowCount: FIXTURE.large.rows },
    })
    // Stored content to rebuild from, or the pass would not enqueue at all.
    await db
      .update(resourceTable)
      .set({ storageKey: `resources/${id}` })
      .where(eq(resourceTable.id, id))
    const brokenQueue = {
      enqueue: async () => {
        throw new Error('queue is down')
      },
    } as unknown as QueueAdapter

    const result = await recordMissingRowGroups(db, {
      storage: fixtureStorage,
      env: testEnv,
      queue: brokenQueue,
    })
    expect(result.reinterpreting).toBe(0)
    expect(result.failed).toBeGreaterThan(0)

    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    expect((row.metadata as { rowGroupRows?: number }).rowGroupRows).toBeUndefined()
  }, 60_000)

  it('does not queue a rebuild for a resource with nothing stored to rebuild from', async () => {
    // Such a job is refused at its first step and leaves the pipeline in error;
    // the figure is recorded instead, and the table paged as it is.
    const id = await createResource({
      fixture: 'large',
      size: FIXTURE.large.rows * 500,
      schema: { columns: WIDE_SCHEMA.columns, rowCount: FIXTURE.large.rows },
    })
    const enqueue = vi.fn(async () => {})
    const result = await recordMissingRowGroups(db, {
      storage: fixtureStorage,
      env: testEnv,
      queue: { enqueue } as unknown as QueueAdapter,
    })
    expect(enqueue).not.toHaveBeenCalled()
    expect(result.reinterpreting).toBe(0)

    const [row] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    expect((row.metadata as { rowGroupRows?: number }).rowGroupRows).toBe(FIXTURE.large.rows)
  }, 60_000)

  it('takes a preview whose object is gone out of the candidates', async () => {
    // Left a candidate, it would be read again on every pass and keep the
    // sysadmin's prompt on screen for good. Recorded as asked-with-no-figure,
    // which reads back as unknown.
    const id = await createResource()
    await db
      .update(resourcePipeline)
      .set({ previewKey: `preview/gone/${id}.parquet` })
      .where(eq(resourcePipeline.resourceId, id))
    const deps = { storage: fixtureStorage, env: testEnv }

    const first = await recordMissingRowGroups(db, deps)
    expect(first.unmeasured).toBe(1)
    expect(first.failed).toBe(0)

    const second = await recordMissingRowGroups(db, deps)
    expect(second).toEqual({ recorded: 0, unmeasured: 0, reinterpreting: 0, failed: 0 })
  }, 60_000)

  it('stops a wide table at the end of the row group it started in', async () => {
    // A row group is what a Parquet read decodes to hand out one row of it, so a
    // page that crossed a boundary would hold two — which a slot cannot afford on
    // a table this wide. Told the rows are 3 MB each, the byte budget affords two
    // of them and one group affords four, so a page that starts three rows in has
    // to stop after one.
    //
    // The size is the estimate's input rather than the fixture's own bytes: what
    // is under test is the arithmetic over a table long enough that the boundary
    // and the end of the file are different places.
    const id = await createResource({ size: ROWS * 3_000_000, rowGroupRows: 4 })

    const aligned = await (await app.request(`${base(id)}/Rows`)).json()
    expect(aligned.value).toHaveLength(2)
    expect(aligned['@odata.nextLink']).toContain('$skip=2')

    const straddling = await (await app.request(`${base(id)}/Rows?$skip=3`)).json()
    expect(straddling.value).toHaveLength(1)
    // And the next page resumes on the boundary, where a whole one fits again
    expect(straddling['@odata.nextLink']).toContain('$skip=4')
  }, 60_000)

  it('rejects a $skip past the safe integer range instead of failing on it', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows?$skip=9999999999999999999999`)
    expect(res.status).toBe(400)
  })

  it('builds context and next links from the configured public origin', async () => {
    // Behind CloudFront the Host that reaches the container is the load
    // balancer's, so a link built from the request would point into the VPC.
    const id = await createResource({ fixture: 'large' })
    await db
      .update(resourcePipeline)
      .set({
        metadata: {
          encoding: 'utf-8',
          sourceHash: 'sha256:live',
          schema: { ...SCHEMA, rowCount: ODATA_MAX_PAGE_ROWS + 1 },
        },
      })
      .where(eq(resourcePipeline.resourceId, id))
    const res = await app.request(`${base(id)}/Rows`, {
      headers: { Host: 'internal-alb-1234.ap-northeast-1.elb.amazonaws.com' },
    })
    const body = await res.json()
    expect(body['@odata.context']).toMatch(/^http:\/\/localhost:3000\/odata\//)
    expect(body['@odata.nextLink']).toMatch(/^http:\/\/localhost:3000\/odata\//)
  }, 60_000)

  it('refuses a page of a reading that is no longer current', async () => {
    // Rows are identified by position, so a client that took page 1 from one
    // reading of the file and page 2 from the next would hold neither table.
    // The fingerprint on the link names the interpretation, not the version
    // (ADR-043): re-reading the same bytes moves it too.
    const id = await createResource({ fixture: 'large' })
    const first = await (await app.request(`${base(id)}/Rows`)).json()
    const next = new URL(first['@odata.nextLink']).search

    // The same page, still current: held for as long as it asks for
    const current = await app.request(`${base(id)}/Rows${next}`)
    expect(current.status).toBe(200)
    // Bounded by what a purge promises, not by how immutable the bytes are
    expect(current.headers.get('Cache-Control')).toBe(`public, max-age=${PINNED_PAGE_MAX_AGE_S}`)
    await current.text()

    // The content is replaced; the page the client was about to fetch is gone
    await db.update(resourceTable).set({ hash: 'sha256:replaced' }).where(eq(resourceTable.id, id))
    await db
      .update(resourcePipeline)
      .set({
        metadata: {
          encoding: 'utf-8',
          sourceHash: 'sha256:replaced',
          schema: { ...SCHEMA, rowCount: ODATA_MAX_PAGE_ROWS + 1 },
        },
      })
      .where(eq(resourcePipeline.resourceId, id))

    const stale = await app.request(`${base(id)}/Rows${next}`)
    expect(stale.status).toBe(410)
    expect((await stale.json()).error.code).toBe('GONE')
    expect(stale.headers.get('Cache-Control')).toBe('private, no-cache')
  }, 120_000)

  it('changes the validator when the preview is rewritten from the same bytes', async () => {
    // A reader fix that moves a column's type produces a new preview from
    // unchanged content: the resource's hash is the same, the table is not.
    const id = await createResource()
    const first = await app.request(`${base(id)}/Rows`)
    const before = first.headers.get('ETag')
    await first.text()

    await db
      .update(resourcePipeline)
      .set({ previewKey: `preview/${id}.rewritten.parquet` })
      .where(eq(resourcePipeline.resourceId, id))

    const second = await app.request(`${base(id)}/Rows`)
    const after = second.headers.get('ETag')
    await second.text()
    expect(after).not.toBe(before)
  })

  it('revalidates a page that names no interpretation, as $metadata does', async () => {
    // The pair has to move together: a page held for a minute beside the
    // current declaration of its columns is two versions in one reader's
    // table, and a table of one page never reaches a next link to find out.
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows`)
    expect(res.headers.get('Cache-Control')).toBe('public, no-cache')
    expect(res.headers.get('ETag')).toBeTruthy()
    await res.text()
  })

  it('answers a private resource without leaving its other read running', async () => {
    // Both statements are issued together; the visibility one fails first, and
    // a `Promise.all` would return 404 with the other still holding a row lock
    // — which the next case's TRUNCATE deadlocks against.
    const id = await createResource({ private: true })
    const res = await app.request(`${base(id)}/Rows`)
    expect(res.status).toBe(404)
    await res.text()
    await cleanDatabase()
  })

  it('answers an integer past 2^53 with its own digits', async () => {
    // `Number(9007199254740993n)` is …92, so a feed that converted would be
    // serving a value the file does not hold.
    const id = await createResource({ fixture: 'wide-int', schema: { ...SCHEMA, rowCount: 1 } })
    const res = await app.request(`${base(id)}/Rows`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"id":9007199254740993')
  })

  it('rejects a non-numeric $top', async () => {
    const id = await createResource()
    const res = await app.request(`${base(id)}/Rows?$top=all`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('answers 304 when the caller already holds this page', async () => {
    const id = await createResource()
    const first = await app.request(`${base(id)}/Rows?$top=2`)
    const etag = first.headers.get('ETag')
    await first.text() // the body is a stream; leaving it unread holds the slot
    expect(etag).toBeTruthy()
    const second = await app.request(`${base(id)}/Rows?$top=2`, {
      headers: { 'If-None-Match': etag! },
    })
    expect(second.status).toBe(304)
  })

  it('changes the validator when the content does', async () => {
    const id = await createResource()
    const first = await app.request(`${base(id)}/Rows`)
    const before = first.headers.get('ETag')
    await first.text()
    await db.update(resourceTable).set({ hash: 'sha256:replaced' }).where(eq(resourceTable.id, id))
    await db
      .update(resourcePipeline)
      .set({ metadata: { encoding: 'utf-8', sourceHash: 'sha256:replaced', schema: SCHEMA } })
      .where(eq(resourcePipeline.resourceId, id))
    const second = await app.request(`${base(id)}/Rows`)
    const after = second.headers.get('ETag')
    await second.text()
    expect(after).not.toBe(before)
  })
})

describe('two pages at once', () => {
  it('serves both, with no temp file shared between them', async () => {
    // Every DuckDB instance that goes out of core writes a spill file named
    // after the block size, not after itself: two of them in one process share
    // `.tmp/duckdb_temp_storage_S32K-0.tmp` and fail each other's reads. The
    // feed allows two pages at once, so this is its own concurrency.
    const id = await createResource({ fixture: 'wide' })
    const [a, b] = await Promise.all([
      app.request(`${base(id)}/Rows`),
      app.request(`${base(id)}/Rows?$skip=1`),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()])
    expect(bodyA.value.length).toBeGreaterThan(0)
    expect(bodyB.value.length).toBeGreaterThan(0)
    expect(bodyB.value[0].RowId).toBe(1)
  }, 60_000)
})

describe('when every slot is taken', () => {
  it('queues, refuses past the queue, and frees the slots on the deadline', async () => {
    // The response is streamed, so back-pressure blocks the writes rather than
    // the reads: without a deadline on the write side, callers that read the
    // headers and stop would hold the feed for good.
    // A wide table, so a page is megabytes and its writes block on a reader
    // that stopped: a page small enough to fit one flush is written and the
    // slot returned whether anyone reads it or not.
    const id = await createResource({ fixture: 'wide' })
    const abandoned = await Promise.all(
      Array.from({ length: capacity.slots }, () => app.request(`${base(id)}/Rows`))
    )
    expect(abandoned.map((r) => r.status)).toEqual(abandoned.map(() => 200))

    // Fill the queue behind them; these are waiting, so they are not awaited yet
    const queued = Array.from({ length: ODATA_QUEUE_MAX }, () => app.request(`${base(id)}/Rows`))
    await new Promise((r) => setTimeout(r, 300))

    // One more than the queue holds is refused at once, and told to come back
    const overflow = await app.request(`${base(id)}/Rows`)
    expect(overflow.status).toBe(429)
    expect(overflow.headers.get('Retry-After')).toBe('5')
    const refused = await overflow.json()
    expect(refused.error.code).toBe('TOO_MANY_REQUESTS')
    // In the feed's words, not the query path's
    expect(JSON.stringify(refused)).toContain('The feed is busy')

    // And the queue drains once the deadline frees the slots: as many callers
    // are served as there are slots, while the rest wait out their own budget
    // and are refused. Which of them is served is not fixed — each request does
    // its own database work before it reaches the semaphore, so the order they
    // queue in is not the order they were sent.
    const results = await Promise.all(queued)
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(capacity.slots)
    await Promise.allSettled(results.map((r) => r.text()))
  }, 120_000)
})

describe('GET /api/v1/resources/:id/schema', () => {
  it('reports whether the OData feed is available', async () => {
    // A feed is offered where the resource is queryable and no refusal comes
    // back; there is no separate flag to disagree with the refusal.
    const open = await createResource()
    const offered = await (await app.request(`/api/v1/resources/${open}/schema`)).json()
    expect([offered.queryable, offered.odataRefusal]).toEqual([true, null])

    const closed = await createResource({ private: true })

    const unnamed = await createResource({
      schema: {
        columns: [{ name: '面積 (km2)', type: 'float', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
    })
    const refused = await (await app.request(`/api/v1/resources/${unnamed}/schema`)).json()
    // Named, so the page can say which heading to fix rather than going quiet
    expect(refused.odataRefusal).toEqual({
      reason: 'unsupported-columns',
      columns: ['面積 (km2)'],
    })
    expect(
      (await (await app.request(`/api/v1/resources/${closed}/schema`)).json()).odataRefusal.reason
    ).toBe('not-public')
    expect(
      (await (await app.request(`/api/v1/resources/${open}/schema`)).json()).odataRefusal
    ).toBe(null)
  })
})
