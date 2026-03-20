/**
 * KUKAN Resource Service
 * Business logic for resource management
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, packageTable } from '@kukan/db'
import { NotFoundError } from '@kukan/shared'
import type { CreateResourceInput, UpdateResourceInput } from '@kukan/shared'

export class ResourceService {
  constructor(private db: Database) {}

  /**
   * List resources for a specific package
   * Ordered by position
   */
  async listByPackage(packageId: string) {
    // Verify package exists
    const [pkg] = await this.db
      .select({ id: packageTable.id })
      .from(packageTable)
      .where(and(eq(packageTable.id, packageId), eq(packageTable.state, 'active')))
      .limit(1)

    if (!pkg) {
      throw new NotFoundError('Package', packageId)
    }

    const resources = await this.db
      .select()
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
      .orderBy(resource.position)

    return resources
  }

  /**
   * Get resource by ID
   */
  async getById(id: string) {
    const [res] = await this.db
      .select()
      .from(resource)
      .where(and(eq(resource.id, id), eq(resource.state, 'active')))
      .limit(1)

    if (!res) {
      throw new NotFoundError('Resource', id)
    }

    return res
  }

  /**
   * Get distinct non-empty formats across all active resources
   */
  async getDistinctFormats(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ format: resource.format })
      .from(resource)
      .where(
        and(
          eq(resource.state, 'active'),
          sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
        )
      )
      .orderBy(resource.format)

    return rows.map((r) => r.format!).filter(Boolean)
  }

  /**
   * Create a new resource
   * Automatically assigns position as max(position) + 1 within the package
   */
  async create(input: CreateResourceInput) {
    return await this.db.transaction(async (tx) => {
      // Verify package exists
      const [pkg] = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(and(eq(packageTable.id, input.package_id), eq(packageTable.state, 'active')))
        .limit(1)

      if (!pkg) {
        throw new NotFoundError('Package', input.package_id)
      }

      // Get max position for this package
      const [maxPos] = await tx
        .select({ maxPosition: sql<number>`COALESCE(MAX(${resource.position}), -1)` })
        .from(resource)
        .where(eq(resource.packageId, input.package_id))

      const nextPosition = (maxPos?.maxPosition ?? -1) + 1

      // Create resource
      const [newResource] = await tx
        .insert(resource)
        .values({
          packageId: input.package_id,
          url: input.url,
          urlType: input.url_type,
          name: input.name,
          description: input.description,
          format: input.format,
          mimetype: input.mimetype,
          size: input.size,
          hash: input.hash,
          position: nextPosition,
          resourceType: input.resource_type,
          extras: input.extras,
          state: 'active',
        })
        .returning()

      return newResource
    })
  }

  /**
   * Update resource
   */
  async update(id: string, input: UpdateResourceInput) {
    const existing = await this.getById(id)

    const [updated] = await this.db
      .update(resource)
      .set({
        url: input.url,
        urlType: input.url_type,
        name: input.name,
        description: input.description,
        format: input.format,
        mimetype: input.mimetype,
        size: input.size,
        hash: input.hash,
        resourceType: input.resource_type,
        extras: input.extras,
        updated: sql`NOW()`,
      })
      .where(eq(resource.id, existing.id))
      .returning()

    return updated
  }

  /**
   * Delete resource (soft delete)
   */
  async delete(id: string) {
    const existing = await this.getById(id)

    const [deleted] = await this.db
      .update(resource)
      .set({
        state: 'deleted',
        updated: sql`NOW()`,
      })
      .where(eq(resource.id, existing.id))
      .returning()

    return deleted
  }

  /**
   * Prepare a resource for file upload (new or replacement).
   * Clears previous upload metadata (size, hash).
   */
  async prepareForUpload(
    id: string,
    input: { filename: string; contentType: string; format?: string },
    existing?: Awaited<ReturnType<ResourceService['getById']>>
  ) {
    existing ??= await this.getById(id)
    const format = input.format || deriveFormat(input.filename) || existing.format

    const [updated] = await this.db
      .update(resource)
      .set({
        url: input.filename,
        urlType: 'upload',
        name: existing.name || input.filename,
        format,
        mimetype: input.contentType,
        size: null,
        hash: null,
        updated: sql`NOW()`,
      })
      .where(eq(resource.id, id))
      .returning()

    return updated!
  }

  /**
   * Update resource metadata after a successful upload.
   */
  async updateAfterUpload(id: string, input: { size?: number; hash?: string }) {
    const [updated] = await this.db
      .update(resource)
      .set({
        ...(input.size !== undefined && { size: input.size }),
        ...(input.hash !== undefined && { hash: input.hash }),
        updated: sql`NOW()`,
      })
      .where(and(eq(resource.id, id), eq(resource.state, 'active')))
      .returning()

    if (!updated) {
      throw new NotFoundError('Resource', id)
    }

    return updated
  }
}

/** Compute storage key from packageId and resourceId */
export function getStorageKey(packageId: string, resourceId: string): string {
  return `resources/${packageId}/${resourceId}`
}

/** Derive format string from filename extension */
function deriveFormat(filename: string): string | undefined {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex <= 0) return undefined
  const ext = filename.slice(dotIndex + 1).toLowerCase()
  const formatMap: Record<string, string> = {
    csv: 'CSV',
    tsv: 'TSV',
    json: 'JSON',
    xml: 'XML',
    xlsx: 'XLSX',
    xls: 'XLS',
    pdf: 'PDF',
    zip: 'ZIP',
    geojson: 'GeoJSON',
  }
  return formatMap[ext] || ext.toUpperCase()
}
