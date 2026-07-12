/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { randomBytes } from 'node:crypto'
import { eq, and, or, sql, getTableColumns, inArray, asc, desc, ilike } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  tag,
  packageTag,
  organization,
  resource,
  resourcePipeline,
  group,
  packageGroup,
} from '@kukan/db'
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  isUuid,
  escapeLike,
  draftPublishBlockers,
  type DraftPublishBlocker,
} from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  FacetCounts,
  PackageState,
  PackageDbState,
} from '@kukan/shared'
import type { SearchFacets, MatchedResource, SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { CreatePackageInput, CreateDraftPackageInput, UpdatePackageInput } from '@kukan/shared'
import { hasOrgMembership, hasDraftAccess, type AuthUser } from '../auth/permissions'
import { deleteOrphanFreeTags } from './tag-service'
import { purgePackageExternals } from './package-cleanup'

/** Random placeholder name for a draft (ADR-039) — replaced before publish */
export function generateDraftPackageName(): string {
  return `untitled-${randomBytes(4).toString('hex')}`
}

const PUBLISH_BLOCKER_MESSAGES: Record<DraftPublishBlocker, string> = {
  name: 'Package name must be set before publishing',
  org: 'Package organization must be set before publishing',
  license: 'Package license must be set before publishing',
}

/** Scalar package columns settable via PUT (subset of {@link UpdatePackageInput}) */
const UPDATABLE_SCALAR_KEYS = [
  'name',
  'title',
  'notes',
  'url',
  'version',
  'licenseId',
  'author',
  'authorEmail',
  'maintainer',
  'maintainerEmail',
  'ownerOrg',
  'private',
  'type',
  'extras',
] as const

/** Pick the given keys from an object, skipping undefined values. */
function pickDefined<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key]
  }
  return out
}

// Public column set — the embedding storage columns are internal (and the
// vector is ~KB per row), so no package row this service returns includes them
const {
  embedding: _embedding,
  embeddingModel: _embeddingModel,
  embeddingHash: _embeddingHash,
  ...packageColumns
} = getTableColumns(packageTable)

type PackageRow = Omit<
  typeof packageTable.$inferSelect,
  'embedding' | 'embeddingModel' | 'embeddingHash'
>
export type PackageAuthorize = (pkg: PackageRow) => Promise<void>

export interface PackageFilterParams {
  /** Package IDs from SearchAdapter */
  searchMatchIds?: string[]
  /** Total count from SearchAdapter (used instead of DB COUNT) */
  searchTotal?: number
  /** Matched resources from SearchAdapter, keyed by package ID */
  searchMatchedResources?: Record<string, MatchedResource[]>
  /** Highlighted fields from SearchAdapter, keyed by package ID */
  searchHighlights?: Record<string, { highlightedTitle?: string; highlightedNotes?: string }>
  /** Package IDs that matched via vector search only (ADR-034) */
  searchSemanticIds?: string[]
  /** Package state filter, single or multiple (default: 'active') */
  state?: PackageDbState | PackageDbState[]
  /**
   * Draft visibility restriction (ADR-039): only drafts created by the user or
   * owned by one of the given editor-role orgs. Omit for sysadmins.
   */
  draftAccess?: { userId: string; editorOrgIds: string[] }
  // Direct-DB filters below serve the draft listing (ADR-039); the active
  // list filters via SearchAdapter instead (ADR-013) and leaves them unset.
  /** ILIKE match on name/title/notes */
  q?: string
  /** Exact name match */
  name?: string
  /** Organization names (OR) */
  organizations?: string[]
  isPrivate?: boolean
  sortBy?: 'updated' | 'created' | 'name'
  sortOrder?: 'asc' | 'desc'
}

export class PackageService {
  constructor(private db: Database) {}

  /** eq/inArray WHERE condition for one or more package states */
  private stateCondition(state: PackageDbState | PackageDbState[]): SQL {
    const states = Array.isArray(state) ? state : [state]
    return states.length === 1
      ? eq(packageTable.state, states[0])
      : inArray(packageTable.state, states)
  }

  /** Build WHERE conditions for package list query */
  private buildConditions(params: PackageFilterParams): SQL[] {
    const states = Array.isArray(params.state) ? params.state : [params.state ?? 'active']
    const conditions: SQL[] = [this.stateCondition(states)]

    // When search results are provided, filter by matched IDs
    if (params.searchMatchIds && params.searchMatchIds.length > 0) {
      conditions.push(inArray(packageTable.id, params.searchMatchIds))
    }

    if (states.includes('draft') && params.draftAccess) {
      const { userId, editorOrgIds } = params.draftAccess
      conditions.push(
        editorOrgIds.length > 0
          ? or(
              eq(packageTable.creatorUserId, userId),
              inArray(packageTable.ownerOrg, editorOrgIds)
            )!
          : eq(packageTable.creatorUserId, userId)
      )
    }

    if (params.q) {
      const pattern = `%${escapeLike(params.q)}%`
      conditions.push(
        or(
          ilike(packageTable.name, pattern),
          ilike(packageTable.title, pattern),
          ilike(packageTable.notes, pattern)
        )!
      )
    }
    if (params.name) {
      conditions.push(eq(packageTable.name, params.name))
    }
    if (params.organizations && params.organizations.length > 0) {
      // organization is left-joined in list(); org-less packages never match
      conditions.push(inArray(organization.name, params.organizations))
    }
    if (params.isPrivate !== undefined) {
      conditions.push(eq(packageTable.private, params.isPrivate))
    }

    return conditions
  }

  async list(params: PaginationParams & PackageFilterParams) {
    const { offset = 0, limit = 20 } = params

    // When search was used but returned no matches, return empty result immediately
    if (params.searchMatchIds !== undefined && params.searchMatchIds.length === 0) {
      return {
        items: [],
        total: params.searchTotal ?? 0,
        offset,
        limit,
      } as PaginatedResult<never>
    }

    const hasSearchResults = params.searchMatchIds && params.searchMatchIds.length > 0

    const conditions = this.buildConditions(params)
    const where = and(...conditions)

    const selectFields = {
      ...packageColumns,
      total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      formats:
        sql<string>`(SELECT COALESCE(string_agg(DISTINCT UPPER("resource"."format"), ',' ORDER BY UPPER("resource"."format")), '') FROM "resource" WHERE "resource"."package_id" = "package"."id" AND "resource"."state" = 'active')`.as(
          'formats'
        ),
      resourceCount:
        sql<number>`(SELECT COUNT(*)::int FROM "resource" WHERE "resource"."package_id" = "package"."id" AND "resource"."state" = 'active')`.as(
          'resource_count'
        ),
      tags: sql<string>`(SELECT COALESCE(string_agg("tag"."name", ',' ORDER BY "tag"."name"), '') FROM "package_tag" JOIN "tag" ON "tag"."id" = "package_tag"."tag_id" WHERE "package_tag"."package_id" = "package"."id")`.as(
        'tags_agg'
      ),
      groups:
        sql<string>`(SELECT COALESCE(string_agg("group"."name" || ':' || COALESCE("group"."title", "group"."name"), ',' ORDER BY "group"."title"), '') FROM "package_group" JOIN "group" ON "group"."id" = "package_group"."group_id" WHERE "package_group"."package_id" = "package"."id")`.as(
          'groups_agg'
        ),
      orgName: organization.name,
      orgTitle: organization.title,
    }

    const baseQuery = this.db
      .select(selectFields)
      .from(packageTable)
      .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
      .where(where)

    // SearchAdapter results: IDs are already paginated and scored
    // DB-only results: apply pagination and ordering (defaults mirror the adapter)
    const sortCol = {
      updated: packageTable.updated,
      created: packageTable.created,
      name: packageTable.name,
    }[params.sortBy ?? 'updated']
    const rows = hasSearchResults
      ? await baseQuery
      : await baseQuery
          .orderBy(params.sortOrder === 'asc' ? asc(sortCol) : desc(sortCol))
          .limit(limit)
          .offset(offset)

    if (hasSearchResults) {
      // Preserve SearchAdapter score order
      const rowById = new Map(rows.map((r) => [r.id, r]))
      const semanticIds = new Set(params.searchSemanticIds)
      const items = params
        .searchMatchIds!.map((id) => rowById.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map(({ total: _, ...row }) => ({
          ...row,
          ...(params.searchMatchedResources?.[row.id] && {
            matchedResources: params.searchMatchedResources[row.id],
          }),
          ...(params.searchHighlights?.[row.id] && params.searchHighlights[row.id]),
          ...(semanticIds.has(row.id) && { matchSource: 'semantic' as const }),
        }))

      return {
        items,
        total: params.searchTotal ?? items.length,
        offset,
        limit,
      } as PaginatedResult<(typeof items)[0]>
    }

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  /**
   * Enrich SearchAdapter facets with all possible values from DB.
   * SearchAdapter only returns non-zero buckets; this supplements with
   * all active orgs/groups/tags/formats/licenses (count=0 for missing).
   */
  async enrichFacets(facets: SearchFacets): Promise<FacetCounts> {
    const orgCountMap = new Map(facets.organizations.map((o) => [o.name, o.count]))
    const groupCountMap = new Map(facets.groups.map((g) => [g.name, g.count]))
    const tagCountMap = new Map(facets.tags.map((t) => [t.name, t.count]))
    const formatCountMap = new Map(facets.formats.map((f) => [f.name, f.count]))
    const licenseCountMap = new Map(facets.licenses.map((l) => [l.name, l.count]))

    const [allOrgs, allGroups, allTags, allFormats, allLicenses] = await Promise.all([
      this.db
        .select({ name: organization.name, title: organization.title })
        .from(organization)
        .where(eq(organization.state, 'active'))
        .orderBy(organization.title),
      this.db
        .select({ name: group.name, title: group.title })
        .from(group)
        .where(eq(group.state, 'active'))
        .orderBy(group.title),
      // Tags/formats join their package so draft-only values never leak into
      // the public facets (ADR-039)
      this.db
        .selectDistinct({ name: tag.name })
        .from(tag)
        .innerJoin(packageTag, eq(packageTag.tagId, tag.id))
        .innerJoin(packageTable, eq(packageTable.id, packageTag.packageId))
        .where(and(sql`${tag.vocabularyId} IS NULL`, eq(packageTable.state, 'active')))
        .orderBy(tag.name),
      this.db
        .selectDistinct({ format: sql<string>`UPPER(${resource.format})`.as('format') })
        .from(resource)
        .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
        .where(
          and(
            eq(resource.state, 'active'),
            eq(packageTable.state, 'active'),
            sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
          )
        )
        .orderBy(sql`UPPER(${resource.format})`),
      this.db
        .selectDistinct({ licenseId: packageTable.licenseId })
        .from(packageTable)
        .where(
          and(
            eq(packageTable.state, 'active'),
            sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`
          )
        )
        .orderBy(packageTable.licenseId),
    ])

    return {
      organizations: allOrgs.map((o) => ({
        name: o.name,
        title: o.title,
        count: orgCountMap.get(o.name) ?? 0,
      })),
      groups: allGroups.map((g) => ({
        name: g.name,
        title: g.title,
        count: groupCountMap.get(g.name) ?? 0,
      })),
      tags: allTags.map((t) => ({
        name: t.name,
        count: tagCountMap.get(t.name) ?? 0,
      })),
      formats: allFormats
        .map((r) => r.format)
        .filter(Boolean)
        .map((f) => ({
          name: f,
          count: formatCountMap.get(f) ?? 0,
        })),
      licenses: allLicenses
        .map((l) => l.licenseId!)
        .filter(Boolean)
        .map((l) => ({
          name: l,
          count: licenseCountMap.get(l) ?? 0,
        })),
    }
  }

  async getByNameOrId(
    nameOrId: string,
    state: PackageDbState | PackageDbState[] = 'active',
    opts?: { tx?: Pick<Database, 'select'>; forUpdate?: boolean }
  ) {
    const base = (opts?.tx ?? this.db)
      .select(packageColumns)
      .from(packageTable)
      .where(
        and(
          isUuid(nameOrId)
            ? or(eq(packageTable.id, nameOrId), eq(packageTable.name, nameOrId))
            : eq(packageTable.name, nameOrId),
          this.stateCondition(state)
        )
      )
    // When both id and name match different rows, prefer the id match (CKAN compat)
    const qb = isUuid(nameOrId)
      ? base.orderBy(sql`CASE WHEN ${packageTable.id} = ${nameOrId} THEN 0 ELSE 1 END`).limit(1)
      : base.limit(1)

    const [result] = opts?.forUpdate ? await qb.for('update') : await qb

    if (!result) {
      throw new NotFoundError('Package', nameOrId)
    }

    return result
  }

  /**
   * Get package by name or ID with private visibility check.
   * Throws NotFoundError if the package is private and the viewer lacks access.
   */
  async getByNameOrIdWithAccessCheck(
    nameOrId: string,
    viewer?: AuthUser,
    state: PackageState | PackageState[] = 'active'
  ) {
    const pkg = await this.getByNameOrId(nameOrId, state)

    // Drafts: creator / sysadmin / owner-org editors only (ADR-039)
    if (pkg.state === 'draft') {
      if (!(await hasDraftAccess(this.db, pkg, viewer))) {
        throw new NotFoundError('Package', nameOrId)
      }
      return pkg
    }

    // Private and deleted packages: org member+ or sysadmin
    // (restore/purge operations are separately guarded by editor+/admin+ role checks)
    const requiresMembership = pkg.state === 'deleted' || pkg.private

    if (requiresMembership && !(await hasOrgMembership(this.db, pkg.ownerOrg, viewer))) {
      throw new NotFoundError('Package', nameOrId)
    }

    return pkg
  }

  async getDetailByNameOrId(
    nameOrId: string,
    viewer?: AuthUser,
    state: PackageState | PackageState[] = 'active'
  ) {
    const pkg = await this.getByNameOrIdWithAccessCheck(nameOrId, viewer, state)

    const [resources, tags, groups, org] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(resource),
          pipelineStatus: resourcePipeline.status,
        })
        .from(resource)
        .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
        .where(and(eq(resource.packageId, pkg.id), eq(resource.state, 'active')))
        .orderBy(resource.position),
      this.db
        .select({ id: tag.id, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(eq(packageTag.packageId, pkg.id)),
      this.db
        .select({ id: group.id, name: group.name, title: group.title })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(eq(packageGroup.packageId, pkg.id)),
      pkg.ownerOrg
        ? this.db
            .select({
              id: organization.id,
              name: organization.name,
              title: organization.title,
              description: organization.description,
              imageUrl: organization.imageUrl,
            })
            .from(organization)
            .where(and(eq(organization.id, pkg.ownerOrg), eq(organization.state, 'active')))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
    ])

    return { ...pkg, resources, tags, groups, organization: org }
  }

  /**
   * Shared INSERT path for {@link create} and {@link createDraft}: name
   * uniqueness check, ownerOrg validation, row insert, tag/group linking.
   * New package columns only need to be added here.
   */
  private async insertPackage(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: CreateDraftPackageInput,
    opts: { name: string; state: 'active' | 'draft'; creatorUserId?: string }
  ) {
    const existing = await tx
      .select({ id: packageTable.id })
      .from(packageTable)
      .where(eq(packageTable.name, opts.name))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError('Package name already exists', { name: opts.name })
    }

    if (input.ownerOrg) {
      await this.assertOwnerOrgActive(
        tx,
        input.ownerOrg,
        new NotFoundError('Organization', input.ownerOrg)
      )
    }

    const [pkg] = await tx
      .insert(packageTable)
      .values({
        name: opts.name,
        title: input.title,
        notes: input.notes,
        url: input.url,
        version: input.version,
        licenseId: input.licenseId,
        author: input.author,
        authorEmail: input.authorEmail,
        maintainer: input.maintainer,
        maintainerEmail: input.maintainerEmail,
        ownerOrg: input.ownerOrg,
        private: input.private ?? false,
        type: input.type ?? 'dataset',
        extras: input.extras ?? {},
        creatorUserId: opts.creatorUserId,
        state: opts.state,
      })
      .returning(packageColumns)

    if (input.tags && input.tags.length > 0) {
      await this.linkTags(tx, pkg.id, input.tags)
    }
    if (input.groups && input.groups.length > 0) {
      await this.linkGroups(tx, pkg.id, input.groups)
    }

    return pkg
  }

  async create(input: CreatePackageInput, creatorUserId?: string) {
    return await this.db.transaction((tx) =>
      this.insertPackage(tx, input, { name: input.name, state: 'active', creatorUserId })
    )
  }

  /** Random 8-hex placeholder; retry the astronomically unlikely collision. */
  private async generateUniquePlaceholderName(tx: Pick<Database, 'select'>): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = generateDraftPackageName()
      const existing = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(eq(packageTable.name, candidate))
        .limit(1)
      if (existing.length === 0) return candidate
    }
    throw new ConflictError('Failed to generate a unique draft name')
  }

  /**
   * Create a draft package (ADR-039). Everything is optional: a missing name
   * gets a random placeholder, ownerOrg may stay unset until publish.
   */
  async createDraft(input: CreateDraftPackageInput, creatorUserId: string) {
    return await this.db.transaction(async (tx) => {
      const name = input.name || (await this.generateUniquePlaceholderName(tx))
      return this.insertPackage(tx, input, { name, state: 'draft', creatorUserId })
    })
  }

  async update(nameOrId: string, input: UpdatePackageInput, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, ['active', 'draft'], {
        tx,
        forUpdate: true,
      })
      if (authorize) await authorize(existing)

      // Only drafts may leave name/ownerOrg unset (ADR-039)
      if (existing.state === 'active' && (!input.name || !input.ownerOrg)) {
        throw new ValidationError('name and ownerOrg are required for a published package')
      }

      // If name is being changed, check uniqueness
      if (input.name && input.name !== existing.name) {
        const duplicate = await tx
          .select({ id: packageTable.id })
          .from(packageTable)
          .where(eq(packageTable.name, input.name))
          .limit(1)

        if (duplicate.length > 0) {
          throw new ValidationError('Package name already exists', { name: input.name })
        }
      }

      // Validate ownerOrg if being changed
      if (input.ownerOrg && input.ownerOrg !== existing.ownerOrg) {
        await this.assertOwnerOrgActive(
          tx,
          input.ownerOrg,
          new NotFoundError('Organization', input.ownerOrg)
        )
      }

      // Active: full-replacement PUT — omitted fields are cleared / reset to
      // defaults. Draft: partial update — only keys present in the request are
      // applied (explicit null still clears a field), so a partial PUT cannot
      // wipe work-in-progress metadata (ADR-039)
      const isDraft = existing.state === 'draft'
      // `name: null` on a draft resets it to a fresh placeholder — back to the
      // "unnamed" state that blocks publish (ADR-039)
      const name =
        isDraft && input.name === null
          ? await this.generateUniquePlaceholderName(tx)
          : (input.name ?? undefined)
      const setValues = isDraft
        ? { ...pickDefined(input, UPDATABLE_SCALAR_KEYS), name }
        : {
            name,
            title: input.title ?? null,
            notes: input.notes ?? null,
            url: input.url ?? null,
            version: input.version ?? null,
            licenseId: input.licenseId ?? null,
            author: input.author ?? null,
            authorEmail: input.authorEmail ?? null,
            maintainer: input.maintainer ?? null,
            maintainerEmail: input.maintainerEmail ?? null,
            ownerOrg: input.ownerOrg,
            private: input.private ?? false,
            type: input.type ?? 'dataset',
            extras: input.extras ?? {},
          }

      const [updated] = await tx
        .update(packageTable)
        .set({ ...setValues, updated: sql`NOW()` })
        .where(eq(packageTable.id, existing.id))
        .returning(packageColumns)

      // Drafts relink tags/groups only when the request includes them
      const tags = isDraft ? input.tags : (input.tags ?? [])
      const groups = isDraft ? input.groups : (input.groups ?? [])
      if (tags) {
        await tx.delete(packageTag).where(eq(packageTag.packageId, existing.id))
        await this.linkTags(tx, existing.id, tags)
        await deleteOrphanFreeTags(tx)
      }
      if (groups) {
        await tx.delete(packageGroup).where(eq(packageGroup.packageId, existing.id))
        await this.linkGroups(tx, existing.id, groups)
      }

      return updated
    })
  }

  async delete(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'active', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      const [deleted] = await tx
        .update(packageTable)
        .set({
          state: 'deleted',
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning(packageColumns)

      return deleted!
    })
  }

  /** Hard-delete a soft-deleted package and all related data (CASCADE). */
  async purge(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'deleted', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      const [purged] = await tx
        .delete(packageTable)
        .where(eq(packageTable.id, existing.id))
        .returning(packageColumns)
      await deleteOrphanFreeTags(tx)
      return purged!
    })
  }

  /** Find-or-create tags by name and link them to a package. */
  private async linkTags(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    packageId: string,
    tags: { name: string }[]
  ) {
    for (const tagInput of tags) {
      let [existingTag] = await tx
        .select()
        .from(tag)
        .where(and(eq(tag.name, tagInput.name), sql`${tag.vocabularyId} IS NULL`))
        .limit(1)

      if (!existingTag) {
        const [newTag] = await tx
          .insert(tag)
          .values({ name: tagInput.name, vocabularyId: null })
          .returning()
        existingTag = newTag
      }

      await tx.insert(packageTag).values({ packageId, tagId: existingTag.id })
    }
  }

  /** Look up active groups by name and link them to a package. Throws if any group is missing. */
  private async linkGroups(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    packageId: string,
    groups: { name: string }[]
  ) {
    for (const groupInput of groups) {
      const [existingGroup] = await tx
        .select({ id: group.id })
        .from(group)
        .where(and(eq(group.name, groupInput.name), eq(group.state, 'active')))
        .limit(1)

      if (!existingGroup) {
        throw new NotFoundError('Group', groupInput.name)
      }

      await tx.insert(packageGroup).values({ packageId, groupId: existingGroup.id })
    }
  }

  /**
   * A package's owner org must be active. Throws the caller-supplied error when it
   * isn't — used by create/update (org being set must exist & be active) and
   * restore (can't resurrect a package under a deleted/purging org). Accepts db or tx.
   */
  private async assertOwnerOrgActive(
    db: Pick<Database, 'select'>,
    ownerOrgId: string,
    error: Error
  ): Promise<void> {
    const [activeOrg] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, ownerOrgId), eq(organization.state, 'active')))
      .limit(1)
    if (!activeOrg) throw error
  }

  /** Restore a soft-deleted package back to active state. */
  async restore(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'deleted', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      // Closes a purge race: restoring a package under a 'purging' org would let the
      // in-flight org purge delete the just-restored package and wipe its files.
      if (existing.ownerOrg) {
        await this.assertOwnerOrgActive(
          tx,
          existing.ownerOrg,
          new ConflictError('Cannot restore a package whose organization is not active')
        )
      }

      const [restored] = await tx
        .update(packageTable)
        .set({
          state: 'active',
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning(packageColumns)

      return restored!
    })
  }

  /**
   * Publish a draft: one-way draft → active transition (ADR-039).
   * Requires a real name (not the auto-generated placeholder), an ownerOrg
   * and a licenseId.
   * Search-index / embed / content-index side effects belong to the caller.
   * Idempotent: an already-active package is returned as-is so the caller can
   * re-run the publish-time sync (retry after a search-sync failure).
   */
  async publish(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, ['draft', 'active'], {
        tx,
        forUpdate: true,
      })
      if (authorize) await authorize(existing)

      if (existing.state === 'active') return existing

      // Shared precondition check (ADR-039) — the license requirement keeps the
      // UI invariant that active packages always carry a license
      const blockers = draftPublishBlockers(existing)
      if (blockers.length > 0) {
        throw new ValidationError(blockers.map((b) => PUBLISH_BLOCKER_MESSAGES[b]).join('; '), {
          blockers,
        })
      }
      // Same guard as restore: never activate a package under a deleted/purging org
      await this.assertOwnerOrgActive(
        tx,
        existing.ownerOrg!,
        new ConflictError('Cannot publish a package whose organization is not active')
      )

      // Atomic claim (ADR-028 shape): the state predicate re-checks 'draft' so a
      // concurrent publish/purge that already moved the row cannot be double-applied
      const [published] = await tx
        .update(packageTable)
        .set({
          state: 'active',
          updated: sql`NOW()`,
        })
        .where(and(eq(packageTable.id, existing.id), eq(packageTable.state, 'draft')))
        .returning(packageColumns)

      if (!published) {
        throw new ConflictError('Package is no longer in draft state')
      }

      return published
    })
  }

  /**
   * Atomic draft → purging claim (ADR-028 shape); see {@link purgeDraft}.
   * Also re-claims 'purging' rows left half-cleaned by a crashed purge, so
   * re-running the DELETE completes the recovery.
   */
  async claimDraftForPurge(nameOrId: string, authorize?: PackageAuthorize) {
    const existing = await this.getByNameOrId(nameOrId, ['draft', 'purging'])
    if (authorize) await authorize(existing)

    const [claimed] = await this.db
      .update(packageTable)
      .set({ state: 'purging' })
      .where(
        and(eq(packageTable.id, existing.id), inArray(packageTable.state, ['draft', 'purging']))
      )
      .returning(packageColumns)
    if (!claimed) {
      throw new ConflictError('Package is no longer in draft state')
    }
    return claimed
  }

  /** Delete the DB rows of a claimed draft. */
  async finalizeDraftPurge(id: string) {
    return await this.db.transaction(async (tx) => {
      const [purged] = await tx
        .delete(packageTable)
        .where(and(eq(packageTable.id, id), eq(packageTable.state, 'purging')))
        .returning(packageColumns)
      if (!purged) {
        throw new ConflictError('Package is no longer claimed for purge')
      }
      await deleteOrphanFreeTags(tx)
      return purged
    })
  }

  /**
   * Purge a draft end-to-end (ADR-039): durable claim, then externals, then
   * the DB rows. Drafts were never published, so this skips the trash; a
   * failure after the claim leaves the row 'purging', and re-running the
   * DELETE re-claims it and finishes the purge.
   */
  async purgeDraft(
    nameOrId: string,
    deps: { search?: SearchAdapter; storage: StorageAdapter },
    authorize?: PackageAuthorize
  ) {
    const claimed = await this.claimDraftForPurge(nameOrId, authorize)
    await purgePackageExternals(claimed.id, deps.search, deps.storage)
    return this.finalizeDraftPurge(claimed.id)
  }
}
