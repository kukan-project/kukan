/**
 * Search index helpers for CUD operations.
 * Builds a DatasetDoc for a single package and indexes it.
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
import type { SearchAdapter, DatasetDoc } from '@kukan/search-adapter'

/**
 * Build a DatasetDoc from DB and upsert it into the search index.
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
    db
      .select({
        id: resource.id,
        name: resource.name,
        description: resource.description,
        format: resource.format,
      })
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
    resources: resources.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      description: r.description ?? undefined,
      format: r.format ?? undefined,
    })),
  }

  await search.index(doc)
}
