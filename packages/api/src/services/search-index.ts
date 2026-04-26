/**
 * Search index helpers.
 * - indexPackageMetadata: single-record upsert for package CUD operations
 * - indexResourceMetadata: single-record upsert for resource CUD operations
 * - rebuildMetadataIndex: batch rebuild of all packages + resources
 */

import { eq, and, inArray } from 'drizzle-orm'
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
import type { Logger } from '@kukan/shared'

/**
 * Build a DatasetDoc from DB and upsert it into the search index (kukan-packages).
 * Does NOT include resource-level data — use indexResourceMetadata() for that.
 */
export async function indexPackageMetadata(
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

// ------------------------------------------------------------------
// Bulk rebuild
// ------------------------------------------------------------------

const BATCH_SIZE = 100

export interface RebuildMetadataResult {
  packagesIndexed: number
  resourcesIndexed: number
}

/**
 * Rebuild package and resource search indices from DB.
 * Content index is not rebuilt here (requires pipeline re-processing).
 * @param clearFirst - If true, delete all documents before re-indexing (default: true).
 *                     Set to false for auto-recovery where indices are already empty.
 */
export async function rebuildMetadataIndex(
  db: Database,
  search: SearchAdapter,
  log: Logger,
  clearFirst = true
): Promise<RebuildMetadataResult> {
  log.info('Starting metadata index rebuild')

  if (clearFirst) {
    await search.deleteAllPackages()
    await search.deleteAllResources()
  }

  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let packagesIndexed = 0
  let resourcesIndexed = 0

  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE)
    const batchIds = batch.map((p) => p.id)

    const [details, allResources, allGroups, allTags] = await Promise.all([
      db
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
        .where(inArray(packageTable.id, batchIds)),
      db
        .select({
          packageId: resource.packageId,
          id: resource.id,
          name: resource.name,
          description: resource.description,
          format: resource.format,
        })
        .from(resource)
        .where(and(inArray(resource.packageId, batchIds), eq(resource.state, 'active'))),
      db
        .select({ packageId: packageGroup.packageId, name: group.name })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(inArray(packageGroup.packageId, batchIds)),
      db
        .select({ packageId: packageTag.packageId, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(inArray(packageTag.packageId, batchIds)),
    ])

    const orgIds = [...new Set(details.map((d) => d.ownerOrg).filter((id): id is string => !!id))]
    const orgMap = new Map<string, string>()
    if (orgIds.length > 0) {
      const orgs = await db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(inArray(organization.id, orgIds))
      for (const o of orgs) orgMap.set(o.id, o.name)
    }

    const resourcesByPkg = new Map<string, typeof allResources>()
    for (const r of allResources) {
      let arr = resourcesByPkg.get(r.packageId)
      if (!arr) {
        arr = []
        resourcesByPkg.set(r.packageId, arr)
      }
      arr.push(r)
    }
    const groupsByPkg = new Map<string, string[]>()
    for (const g of allGroups) {
      let arr = groupsByPkg.get(g.packageId)
      if (!arr) {
        arr = []
        groupsByPkg.set(g.packageId, arr)
      }
      arr.push(g.name)
    }
    const tagsByPkg = new Map<string, string[]>()
    for (const t of allTags) {
      let arr = tagsByPkg.get(t.packageId)
      if (!arr) {
        arr = []
        tagsByPkg.set(t.packageId, arr)
      }
      arr.push(t.name)
    }

    const packageDocs: DatasetDoc[] = details.map((detail) => {
      const pkgResources = resourcesByPkg.get(detail.id) ?? []
      const formatSet = new Set(
        pkgResources.map((r) => r.format?.toUpperCase()).filter((f): f is string => !!f)
      )
      return {
        id: detail.id,
        name: detail.name,
        title: detail.title ?? undefined,
        notes: detail.notes ?? undefined,
        organization: detail.ownerOrg ? orgMap.get(detail.ownerOrg) : undefined,
        license_id: detail.licenseId ?? undefined,
        groups: groupsByPkg.get(detail.id) ?? [],
        tags: tagsByPkg.get(detail.id) ?? [],
        formats: [...formatSet],
        private: detail.private,
        owner_org_id: detail.ownerOrg ?? undefined,
        creator_user_id: detail.creatorUserId ?? undefined,
        created: detail.created,
        updated: detail.updated,
      }
    })

    const resourceDocs: ResourceDoc[] = allResources.map((r) => ({
      id: r.id,
      packageId: r.packageId,
      name: r.name ?? undefined,
      description: r.description ?? undefined,
      format: r.format ?? undefined,
    }))

    if (packageDocs.length > 0) {
      await search.bulkIndexPackages(packageDocs)
      packagesIndexed += packageDocs.length
    }
    if (resourceDocs.length > 0) {
      await search.bulkIndexResources(resourceDocs)
      resourcesIndexed += resourceDocs.length
    }
  }

  log.info({ packagesIndexed, resourcesIndexed }, 'Metadata index rebuild complete')
  return { packagesIndexed, resourcesIndexed }
}
