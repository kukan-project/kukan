/**
 * Search index helpers for CUD operations.
 * - indexPackage: builds a DatasetDoc (metadata only) and indexes to kukan-packages
 * - indexResource: indexes a single resource to kukan-resources (metadata, no content)
 */

import { eq, and } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  resource,
  organization,
  group,
  packageGroup,
  packageTag,
  tag,
} from '@kukan/db'
import type { SearchAdapter, DatasetDoc, ResourceDoc } from '@kukan/search-adapter'

/**
 * Build a DatasetDoc from DB and upsert it into the search index (kukan-packages).
 * Does NOT include resource-level data — use indexResource() for that.
 */
export async function indexPackage(
  db: Database,
  search: SearchAdapter,
  packageId: string
): Promise<void> {
  const [pkg] = await db
    .select({
      id: packageTable.id,
      name: packageTable.name,
      title: packageTable.title,
      notes: packageTable.notes,
      ownerOrg: packageTable.ownerOrg,
      private: packageTable.private,
      creatorUserId: packageTable.creatorUserId,
      licenseId: packageTable.licenseId,
      created: packageTable.created,
      updated: packageTable.updated,
    })
    .from(packageTable)
    .where(and(eq(packageTable.id, packageId), eq(packageTable.state, 'active')))
    .limit(1)

  if (!pkg) return

  const [resources, orgRow, groups, tags] = await Promise.all([
    // Only fetch format for the formats facet
    db
      .select({ format: resource.format })
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active'))),
    pkg.ownerOrg
      ? db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, pkg.ownerOrg))
          .limit(1)
          .then(([r]) => r ?? null)
      : Promise.resolve(null),
    db
      .select({ name: group.name })
      .from(packageGroup)
      .innerJoin(group, eq(packageGroup.groupId, group.id))
      .where(eq(packageGroup.packageId, packageId)),
    db
      .select({ name: tag.name })
      .from(packageTag)
      .innerJoin(tag, eq(packageTag.tagId, tag.id))
      .where(eq(packageTag.packageId, packageId)),
  ])

  const formatSet = new Set(
    resources.map((r) => r.format?.toUpperCase()).filter((f): f is string => !!f)
  )

  const doc: DatasetDoc = {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    organization: orgRow?.name ?? undefined,
    license_id: pkg.licenseId ?? undefined,
    groups: groups.map((g) => g.name),
    tags: tags.map((t) => t.name),
    formats: [...formatSet],
    private: pkg.private,
    owner_org_id: pkg.ownerOrg ?? undefined,
    creator_user_id: pkg.creatorUserId ?? undefined,
    created: pkg.created,
    updated: pkg.updated,
  }

  await search.indexPackage(doc)
}

/**
 * Index a single resource's metadata into kukan-resources.
 * Does NOT include extractedText — that is added by the pipeline Index step.
 */
export async function indexResourceMetadata(
  db: Database,
  search: SearchAdapter,
  resourceId: string
): Promise<void> {
  const [res] = await db
    .select({
      id: resource.id,
      packageId: resource.packageId,
      name: resource.name,
      description: resource.description,
      format: resource.format,
    })
    .from(resource)
    .where(and(eq(resource.id, resourceId), eq(resource.state, 'active')))
    .limit(1)

  if (!res) return

  const doc: ResourceDoc = {
    id: res.id,
    packageId: res.packageId,
    name: res.name ?? undefined,
    description: res.description ?? undefined,
    format: res.format ?? undefined,
  }

  await search.indexResource(doc)
}
