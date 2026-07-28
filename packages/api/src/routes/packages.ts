/**
 * KUKAN Packages REST API Routes
 * /api/v1/packages endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { PackageService } from '../services/package-service'
import { ResourceService } from '../services/resource-service'
import { PipelineService } from '../services/pipeline-service'
import {
  createPackageSchema,
  createDraftPackageSchema,
  updatePackageSchema,
  createResourceBodySchema,
  reorderResourcesSchema,
  suggestMetadataRequestSchema,
  UnauthorizedError,
  ValidationError,
  ServiceUnavailableError,
  PACKAGE_STATES,
} from '@kukan/shared'
import type { MatchedResource, SearchFilters } from '@kukan/search-adapter'
import {
  checkOrgRole,
  makePackageAuthorize,
  resolveUserOrgIds,
  buildVisibilityFilters,
  type AuthUser,
} from '../auth/permissions'
import {
  syncPackageMetadata,
  indexResourceMetadata,
  indexResourceDocFromRow,
} from '../services/search-index'
import { hybridSearch } from '../services/hybrid-search'
import { lakeConfigFromEnv } from '@kukan/lake'
import { MetadataSuggestService } from '../services/metadata-suggest-service'
import { suggestRateLimiter } from '../services/suggest/rate-limit'
import { getSuggestAvailability } from '../services/suggest/availability'
import type { AppContext } from '../context'
import type { Database } from '@kukan/db'
import type { PackageAuthorize } from '../services/package-service'

export const packagesRouter = new Hono<{ Variables: AppContext }>()

/**
 * Publish authorization (ADR-039): draft access alone is not enough — when the
 * draft has an ownerOrg, editor rights in that org are re-verified at publish
 * time, so a creator who left the org cannot publish in its name.
 */
function makePublishAuthorize(db: Database, user: AuthUser): PackageAuthorize {
  const base = makePackageAuthorize(db, user, 'editor')
  return async (existing) => {
    await base(existing)
    if (existing.state === 'draft' && existing.ownerOrg) {
      await checkOrgRole(db, user, existing.ownerOrg, 'editor')
    }
  }
}

const stateParam = z.enum(PACKAGE_STATES).optional()

// Repeated query param: normalizes string | string[] → string[] | undefined
const repeatedParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).filter(Boolean)))

// GET /api/v1/packages - List packages with pagination and search
packagesRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      q: z.string().optional(),
      name: z.string().optional(),
      organization: repeatedParam,
      groups: repeatedParam,
      tags: repeatedParam,
      res_format: repeatedParam,
      license_id: repeatedParam,
      creator_user_id: z.string().optional(),
      state: stateParam,
      my_org: z
        .string()
        .optional()
        .transform((val) => val === 'true'),
      private: z
        .string()
        .optional()
        .transform((val) => (val === 'true' ? true : val === 'false' ? false : undefined)),
      include_facets: z
        .string()
        .optional()
        .transform((val) => val === 'true'),
      sort_by: z.enum(['updated', 'created', 'name']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
      // semantic=false disables the vector leg of hybrid search (default: on)
      semantic: z
        .string()
        .optional()
        .transform((val) => val !== 'false'),
    })
  ),
  async (c) => {
    const { my_org, tags, res_format, include_facets, state, sort_by, sort_order, ...rest } =
      c.req.valid('query')
    const db = c.get('db')
    const service = new PackageService(db)
    const user = c.get('user')

    // state=draft: dashboard-only DB listing — drafts are never in the search
    // index, and visibility is creator/editor-org based (ADR-039)
    if (state === 'draft') {
      if (!user) throw new UnauthorizedError()
      // Search-index-backed filters are not implemented on this direct-DB
      // path — reject them rather than silently ignore
      const unsupported = Object.entries({
        tags: tags?.length,
        groups: rest.groups?.length,
        res_format: res_format?.length,
        license_id: rest.license_id?.length,
        creator_user_id: rest.creator_user_id,
        my_org,
        include_facets,
      })
        .filter(([, used]) => used)
        .map(([key]) => key)
      if (unsupported.length > 0) {
        throw new ValidationError(
          `Filters not supported with state=draft: ${unsupported.join(', ')}`
        )
      }
      const editorOrgIds = await resolveUserOrgIds(db, user, 'editor')
      // 'purging' rows (a draft purge that crashed mid-flight) are included so
      // the dashboard can offer the DELETE retry that completes the purge
      const result = await service.list({
        offset: rest.offset,
        limit: rest.limit,
        q: rest.q,
        name: rest.name,
        organizations: rest.organization,
        isPrivate: rest.private,
        sortBy: sort_by,
        sortOrder: sort_order,
        state: ['draft', 'purging'],
        ...(editorOrgIds !== undefined && {
          draftAccess: { userId: user.id, editorOrgIds },
        }),
      })
      return c.json(result)
    }

    // state=deleted is only allowed when my_org=true AND user is authenticated
    const effectiveState = state === 'deleted' && my_org && user ? 'deleted' : 'active'

    // Resolve user's org memberships (for visibility and my_org filters)
    const userOrgIds = await resolveUserOrgIds(db, user)

    // my_org=true with no memberships → guaranteed empty result
    if (my_org && userOrgIds !== undefined && userOrgIds.length === 0) {
      return c.json({ items: [], total: 0, offset: rest.offset, limit: rest.limit })
    }

    // Build visibility + access filters for SearchAdapter
    const filters: SearchFilters = {
      name: rest.name,
      organizations: rest.organization,
      tags,
      formats: res_format,
      licenses: rest.license_id,
      groups: rest.groups,
      ...buildVisibilityFilters(user, userOrgIds),
      // my_org filter
      ...(my_org && userOrgIds?.length && { ownerOrgIds: userOrgIds }),
      // Explicit filters
      ...(rest.private !== undefined && { isPrivate: rest.private }),
      ...(rest.creator_user_id && { creatorUserId: rest.creator_user_id }),
      state: effectiveState,
    }

    // Dashboard (my_org=true) uses PostgreSQL adapter for DB consistency.
    // A search-backend outage surfaces as ServiceUnavailableError (503) from the
    // OpenSearch adapter; DB errors propagate as 500. See SearchAdapter for the mapping.
    const search = my_org ? c.get('dbSearch') : c.get('search')
    const searchResult = await hybridSearch(
      { ...c.var, search },
      {
        q: rest.q ?? '',
        offset: rest.offset,
        limit: rest.limit,
        filters,
        facets: include_facets,
        sortBy: sort_by,
        sortOrder: sort_order,
        // Dashboard filtering (my_org) must stay deterministic — no fusion there
        semantic: rest.semantic && !my_org,
      }
    )

    // Build matchedResources + highlights lookup from search results
    const searchMatchedResources: Record<string, MatchedResource[]> = {}
    const searchHighlights: Record<
      string,
      { highlightedTitle?: string; highlightedNotes?: string }
    > = {}
    for (const item of searchResult.items) {
      if (item.matchedResources && item.matchedResources.length > 0) {
        searchMatchedResources[item.id] = item.matchedResources
      }
      if (item.highlightedTitle || item.highlightedNotes) {
        searchHighlights[item.id] = {
          ...(item.highlightedTitle && { highlightedTitle: item.highlightedTitle }),
          ...(item.highlightedNotes && { highlightedNotes: item.highlightedNotes }),
        }
      }
    }

    // SearchAdapter handles visibility + name filter; service.list only does DB enrichment
    const result = await service.list({
      searchMatchIds: searchResult.items.map((i) => i.id),
      searchTotal: searchResult.total,
      searchMatchedResources,
      searchHighlights,
      searchSemanticIds: searchResult.items
        .filter((i) => i.matchSource === 'semantic')
        .map((i) => i.id),
      state: effectiveState,
    })

    if (include_facets && searchResult.facets) {
      const facets = await service.enrichFacets(searchResult.facets)
      return c.json({ ...result, facets })
    }
    return c.json(result)
  }
)

// POST /api/v1/packages/highlights - Fetch content highlights for specific chunks (lazy loading)
packagesRouter.post(
  '/highlights',
  zValidator(
    'json',
    z.object({
      q: z.string().min(1),
      chunks: z.array(z.string()).min(1).max(200),
    })
  ),
  async (c) => {
    const { q, chunks } = c.req.valid('json')
    const db = c.get('db')
    const user = c.get('user')
    const search = c.get('search')

    // Apply the same visibility scope as search/list so callers cannot pull
    // highlights for chunks of private datasets they cannot see (chunk IDs are
    // deterministic — `<resourceId>_chunk_<n>` — and therefore guessable).
    const userOrgIds = await resolveUserOrgIds(db, user)
    const filters: SearchFilters = buildVisibilityFilters(user, userOrgIds)

    const result = await search.fetchContentHighlights(chunks, q, filters)
    return c.json(result)
  }
)

// POST /api/v1/packages - Create new package (org editor+)
packagesRouter.post('/', zValidator('json', createPackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const input = c.req.valid('json')
  const db = c.get('db')
  await checkOrgRole(db, user, input.ownerOrg, 'editor')

  const service = new PackageService(db)
  const pkg = await service.create(input, user.id)
  await syncPackageMetadata(db, c.var, pkg.id)
  return c.json(pkg, 201)
})

// POST /api/v1/packages/drafts - Create draft package (any authenticated user, ADR-039)
packagesRouter.post('/drafts', zValidator('json', createDraftPackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const input = c.req.valid('json')
  const db = c.get('db')
  // Attaching an org at creation still requires editor rights in that org
  if (input.ownerOrg) {
    await checkOrgRole(db, user, input.ownerOrg, 'editor')
  }

  const service = new PackageService(db)
  const pkg = await service.createDraft(input, user.id)
  // No search sync — drafts stay out of the index until publish
  return c.json(pkg, 201)
})

// GET /api/v1/packages/:nameOrId - Get package by name or ID
packagesRouter.get(
  '/:nameOrId',
  zValidator('query', z.object({ state: stateParam })),
  async (c) => {
    const nameOrId = c.req.param('nameOrId')
    const user = c.get('user')
    // state=deleted / state=draft require an authenticated user
    const reqState = c.req.valid('query').state
    const effectiveState = reqState && reqState !== 'active' && user ? reqState : 'active'
    const service = new PackageService(c.get('db'))
    const pkg = await service.getDetailByNameOrId(nameOrId, user, effectiveState)
    return c.json(pkg)
  }
)

// PUT /api/v1/packages/:nameOrId - Update package (org editor+ / draft editors)
packagesRouter.put('/:nameOrId', zValidator('json', updatePackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const input = c.req.valid('json')
  const service = new PackageService(db)

  const pkg = await service.update(nameOrId, input, async (existing) => {
    await makePackageAuthorize(db, user, 'editor')(existing)
    // Changing ownerOrg requires editor role in the target org
    if (input.ownerOrg && input.ownerOrg !== existing.ownerOrg) {
      await checkOrgRole(db, user, input.ownerOrg, 'editor')
    }
  })

  // syncPackageMetadata skips drafts — they stay out of the index until publish (ADR-039)
  await syncPackageMetadata(db, c.var, pkg.id)
  return c.json(pkg)
})

// DELETE /api/v1/packages/:nameOrId - Delete package (org editor+ / draft editors)
// Drafts skip the trash and are hard-deleted immediately (ADR-039). 'purging'
// rows (a draft purge that crashed mid-flight) are recovered the same way.
packagesRouter.delete('/:nameOrId', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)

  const existing = await service.getByNameOrId(nameOrId, ['active', 'draft', 'purging'])
  if (existing.state === 'draft' || existing.state === 'purging') {
    const purged = await service.purgeDraft(
      existing.id,
      { search: c.get('search'), storage: c.get('storage'), lake: lakeConfigFromEnv(c.get('env')) },
      makePackageAuthorize(db, user, 'editor')
    )
    return c.json(purged)
  }

  const pkg = await service.delete(nameOrId, makePackageAuthorize(db, user, 'editor'))

  await c.get('search').deletePackage(pkg.id)
  return c.json(pkg)
})

// POST /api/v1/packages/:nameOrId/publish - Publish a draft (draft editors, ADR-039)
// Idempotent: re-publishing an active package re-runs the sync below, so a
// failed publish-time search sync can be retried with the same request
packagesRouter.post('/:nameOrId/publish', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)

  const pkg = await service.publish(nameOrId, makePublishAuthorize(db, user))

  // Now-visible package: index metadata + enqueue embedding, index each
  // resource's metadata, and re-run pipelines for content indexing (the Index
  // step skipped search indexing for these resources while the package was a
  // draft — only document text-head artifacts were produced, ADR-040).
  // Failures propagate as 500: the package is already active and publish is
  // idempotent, so re-running the same request retries the whole sync
  const resources = await new ResourceService(db).listByPackage(pkg.id)
  const pipelineService = new PipelineService(db, c.get('queue'))
  await Promise.all([
    syncPackageMetadata(db, c.var, pkg.id),
    ...resources.map((r) => indexResourceDocFromRow(c.get('search'), r)),
    ...resources.filter((r) => r.url).map((r) => pipelineService.enqueue(r.id)),
  ])
  return c.json(pkg)
})

// POST /api/v1/packages/:nameOrId/suggest-metadata - AI metadata suggestions (ADR-040)
// Synchronous and stateless: nothing is persisted; adopting a suggested value
// happens through the ordinary PUT. Same permission as updating the package.
packagesRouter.post(
  '/:nameOrId/suggest-metadata',
  zValidator('json', suggestMetadataRequestSchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()

    const availability = await getSuggestAvailability(c.get('ai'), c.get('settings'))
    if (!availability) {
      throw new ServiceUnavailableError('AI suggestions are not available')
    }

    const db = c.get('db')
    const service = new PackageService(db)
    const pkg = await service.getDetailByNameOrId(c.req.param('nameOrId'), user, [
      'active',
      'draft',
    ])
    await makePackageAuthorize(db, user, 'editor')(pkg)

    // After authorization so denied requests never consume quota
    suggestRateLimiter.check(user.id)

    const suggestService = new MetadataSuggestService(
      db,
      c.get('storage'),
      c.get('ai'),
      c.get('logger')
    )
    const result = await suggestService.suggest(pkg, user, {
      locale: c.req.valid('json').locale,
      ...availability,
    })
    return c.json(result)
  }
)

// POST /api/v1/packages/:nameOrId/purge - Permanently delete a soft-deleted package (org admin+)
packagesRouter.post('/:nameOrId/purge', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)

  // Rows, search docs and every external trace — raw files, previews, retained
  // versions, DuckLake tables — all under the resources' claim (ADR-044).
  const pkg = await service.purge(
    nameOrId,
    { search: c.get('search'), storage: c.get('storage'), lake: lakeConfigFromEnv(c.get('env')) },
    makePackageAuthorize(db, user, 'admin')
  )
  return c.json(pkg)
})

// POST /api/v1/packages/:nameOrId/restore - Restore a soft-deleted package (org admin+)
packagesRouter.post('/:nameOrId/restore', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)

  const pkg = await service.restore(nameOrId, makePackageAuthorize(db, user, 'admin'))

  await syncPackageMetadata(db, c.var, pkg.id)
  return c.json(pkg)
})

// PUT /api/v1/packages/:packageId/resources/reorder - Reorder resources (org editor+)
packagesRouter.put(
  '/:packageId/resources/reorder',
  zValidator('json', reorderResourcesSchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()

    const db = c.get('db')
    const packageId = c.req.param('packageId')

    const packageService = new PackageService(db)
    const pkg = await packageService.getByNameOrId(packageId, ['active', 'draft'])
    await makePackageAuthorize(db, user, 'editor')(pkg)

    const { resourceIds } = c.req.valid('json')
    const resourceService = new ResourceService(db)
    const resources = await resourceService.reorder(pkg.id, resourceIds)

    return c.json(resources)
  }
)

// GET /api/v1/packages/:packageId/resources - List resources for package
packagesRouter.get('/:packageId/resources', async (c) => {
  const packageId = c.req.param('packageId')
  const user = c.get('user')
  const packageService = new PackageService(c.get('db'))
  // Resolve name or ID to UUID, with private/draft visibility check
  const pkg = await packageService.getByNameOrIdWithAccessCheck(packageId, user, [
    'active',
    'draft',
  ])

  const resourceService = new ResourceService(c.get('db'))
  const resources = await resourceService.listByPackage(pkg.id)
  return c.json(resources)
})

// POST /api/v1/packages/:packageId/resources - Add resource to package (org editor+)
packagesRouter.post(
  '/:packageId/resources',
  zValidator('json', createResourceBodySchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()

    const db = c.get('db')
    const packageId = c.req.param('packageId')
    const input = c.req.valid('json')

    const packageService = new PackageService(db)
    const pkg = await packageService.getByNameOrId(packageId, ['active', 'draft'])
    await makePackageAuthorize(db, user, 'editor')(pkg)

    const resourceService = new ResourceService(db)
    const resource = await resourceService.create({
      ...input,
      packageId: pkg.id,
    })

    // Enqueue pipeline + index search in parallel (best-effort enqueue)
    // Skip upload resources — pipeline is triggered by upload-complete after file is in storage
    const enqueuePromise =
      input.url && input.urlType !== 'upload'
        ? new PipelineService(db, c.get('queue')).enqueue(resource.id).catch((err) => {
            c.get('logger').error(
              { err, resourceId: resource.id },
              'Best-effort pipeline enqueue failed'
            )
          })
        : Promise.resolve()

    // Both sync helpers skip drafts — metadata/resources are indexed at publish (ADR-039)
    await Promise.all([
      enqueuePromise,
      syncPackageMetadata(db, c.var, pkg.id),
      indexResourceMetadata(db, c.get('search'), resource.id),
    ])
    return c.json(resource, 201)
  }
)
