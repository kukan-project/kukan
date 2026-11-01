/**
 * A resource the query path accepts: a package under an organization, a CSV
 * resource on it, and a successful pipeline row whose preview describes the
 * resource's current bytes (the hashes match). The Parquet itself is whatever
 * the test's storage stub hands back for its signed URL.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { resource as resourceTable, resourcePipeline, type Database } from '@kukan/db'
import type { ResourceSchema } from '@kukan/shared'
import type { createTestApp } from './test-app'

/** The schema the pipeline row declares: id BIGINT, name VARCHAR; 100 rows. */
export const QUERYABLE_SCHEMA: ResourceSchema = {
  columns: [
    { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
    { name: 'name', type: 'string', nullable: false, nullCount: 0 },
  ],
  rowCount: 100,
}

export interface QueryableResourceOptions {
  /** The organization to put the package under; created when not given. */
  orgId?: string
  private?: boolean
  /** Attach no pipeline row at all. */
  pipeline?: false
  /** Attach a partial row: the not-yet-queryable states. */
  noSchema?: boolean
  noPreviewKey?: boolean
  /** Preview left behind by a failed re-interpretation of replaced content. */
  stale?: boolean
}

/**
 * Create a resource and attach a pipeline row through `app` (a sysadmin's). By
 * default it is fully queryable; the options take that away piece by piece.
 */
export async function createQueryableResource(
  app: ReturnType<typeof createTestApp>,
  db: Database,
  opts: QueryableResourceOptions = {}
): Promise<string> {
  let orgId = opts.orgId
  if (!orgId) {
    const orgRes = await app.request('/api/v1/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `q-org-${randomUUID().slice(0, 8)}` }),
    })
    orgId = (await orgRes.json()).id as string
  }
  const pkgRes = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `q-pkg-${randomUUID().slice(0, 8)}`,
      ownerOrg: orgId,
      private: opts.private ?? false,
    }),
  })
  const pkg = await pkgRes.json()
  const resRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'data.csv', format: 'CSV' }),
  })
  const resource = await resRes.json()

  if (opts.pipeline !== false) {
    // Queryable requires the preview to describe the current bytes: the
    // resource's hash and the pipeline's sourceHash must match.
    await db
      .update(resourceTable)
      .set({ hash: 'sha256:live' })
      .where(eq(resourceTable.id, resource.id))
    const sourceHash = opts.stale ? 'sha256:old' : 'sha256:live'
    await db.insert(resourcePipeline).values({
      resourceId: resource.id,
      status: 'success',
      previewKey: opts.noPreviewKey ? null : `preview/${resource.id}.parquet`,
      metadata: opts.noSchema
        ? { encoding: 'utf-8', sourceHash }
        : { encoding: 'utf-8', schema: QUERYABLE_SCHEMA, sourceHash },
    })
  }
  return resource.id as string
}
