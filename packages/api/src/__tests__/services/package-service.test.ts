import { describe, it, expect, beforeEach } from 'vitest'
import { DRAFT_NAME_PLACEHOLDER_RE } from '@kukan/shared'
import { PackageService, generateDraftPackageName } from '../../services/package-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createPackageFixture } from '../test-helpers/fixtures'

describe('PackageService', () => {
  let service: PackageService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new PackageService(mock.db)
  })

  describe('list', () => {
    it('should return paginated result', async () => {
      const pkg = { ...createPackageFixture(), total: 1 }
      mock.addResult([pkg])

      const result = await service.list({ offset: 0, limit: 20 })
      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.offset).toBe(0)
      expect(result.limit).toBe(20)
    })

    it('should use default offset and limit', async () => {
      mock.addResult([])

      const result = await service.list({})
      expect(result.offset).toBe(0)
      expect(result.limit).toBe(20)
    })
  })

  describe('getByNameOrId', () => {
    it('should return package when found by name', async () => {
      const pkg = createPackageFixture({ name: 'my-dataset' })
      mock.addResult([pkg])

      const result = await service.getByNameOrId('my-dataset')
      expect(result.name).toBe('my-dataset')
    })

    it('should return package when found by UUID', async () => {
      const pkg = createPackageFixture()
      mock.addResult([pkg])

      const result = await service.getByNameOrId(pkg.id as string)
      expect(result.id).toBe(pkg.id)
    })

    it('should throw NotFoundError when not found', async () => {
      mock.addResult([]) // empty result

      await expect(service.getByNameOrId('nonexistent')).rejects.toThrow(
        'Package not found: nonexistent'
      )
    })
  })

  describe('create', () => {
    it('should throw ValidationError if name already exists', async () => {
      mock.addResult([{ id: 'existing' }]) // name check returns match

      await expect(
        service.create({
          name: 'duplicate',
          ownerOrg: '550e8400-e29b-41d4-a716-446655440000',
          private: false,
          type: 'dataset',
          extras: {},
          tags: [],
          groups: [],
          resources: [],
        })
      ).rejects.toThrow('Package name already exists')
    })

    it('should throw NotFoundError if ownerOrg does not exist', async () => {
      mock.addResult([]) // name check: no duplicate
      mock.addResult([]) // org check: not found

      await expect(
        service.create({
          name: 'new-pkg',
          ownerOrg: '550e8400-e29b-41d4-a716-446655440000',
          private: false,
          type: 'dataset',
          extras: {},
          tags: [],
          groups: [],
          resources: [],
        })
      ).rejects.toThrow('Organization not found')
    })

    it('should create package successfully', async () => {
      const created = createPackageFixture({ name: 'new-pkg' })
      mock.addResult([]) // name check: no duplicate
      mock.addResult([{ id: '550e8400-e29b-41d4-a716-446655440000' }]) // org check: found
      mock.addResult([created]) // insert returning

      const result = await service.create({
        name: 'new-pkg',
        ownerOrg: '550e8400-e29b-41d4-a716-446655440000',
        private: false,
        type: 'dataset',
        extras: {},
        tags: [],
        groups: [],
        resources: [],
      })
      expect(result.name).toBe('new-pkg')
    })
  })

  describe('update', () => {
    it('should throw NotFoundError for non-existent package', async () => {
      mock.addResult([]) // getByNameOrId returns nothing

      await expect(service.update('nonexistent', { name: 'updated' })).rejects.toThrow(
        'Package not found: nonexistent'
      )
    })

    it('should reject an active package update without name/ownerOrg', async () => {
      const pkg = createPackageFixture({ state: 'active' })
      mock.addResult([pkg]) // getByNameOrId

      await expect(service.update(pkg.id as string, { title: 'no name' })).rejects.toThrow(
        'name and ownerOrg are required'
      )
    })

    it('should allow a draft update without name/ownerOrg', async () => {
      const draft = createPackageFixture({ state: 'draft', name: 'untitled-ab12cd34' })
      mock.addResult([draft]) // getByNameOrId
      mock.addResult([{ ...draft, title: 'WIP' }]) // update returning

      const result = await service.update(draft.id as string, { title: 'WIP' })
      expect(result.title).toBe('WIP')
    })

    it('should reject name: null on an active package', async () => {
      const pkg = createPackageFixture({ state: 'active' })
      mock.addResult([pkg]) // getByNameOrId

      await expect(
        service.update(pkg.id as string, {
          name: null,
          ownerOrg: '550e8400-e29b-41d4-a716-446655440000',
        })
      ).rejects.toThrow('name and ownerOrg are required')
    })

    it('should regenerate a placeholder when a draft name is cleared with null (ADR-039)', async () => {
      const draft = createPackageFixture({ state: 'draft', name: 'real-name' })
      mock.addResult([draft]) // getByNameOrId
      mock.addResult([]) // placeholder candidate probe: free
      mock.addResult([{ ...draft, name: 'untitled-deadbeef' }]) // update returning

      const result = await service.update(draft.id as string, { name: null })
      expect(result.name).toMatch(DRAFT_NAME_PLACEHOLDER_RE)
    })
  })

  describe('createDraft (ADR-039)', () => {
    it('generateDraftPackageName should match the placeholder pattern', () => {
      for (let i = 0; i < 5; i++) {
        expect(generateDraftPackageName()).toMatch(DRAFT_NAME_PLACEHOLDER_RE)
      }
    })

    it('should create a draft with a generated placeholder name', async () => {
      const draft = createPackageFixture({ state: 'draft', name: 'untitled-ab12cd34' })
      mock.addResult([]) // placeholder candidate probe: free
      mock.addResult([]) // insertPackage name check
      mock.addResult([draft]) // insert returning

      const result = await service.createDraft({}, 'user-1')
      expect(result.state).toBe('draft')
      expect(result.name).toMatch(DRAFT_NAME_PLACEHOLDER_RE)
    })

    it('should reject a user-supplied name that already exists', async () => {
      mock.addResult([{ id: 'existing' }]) // name check: taken

      await expect(service.createDraft({ name: 'duplicate' }, 'user-1')).rejects.toThrow(
        'Package name already exists'
      )
    })

    it('should validate ownerOrg when provided', async () => {
      mock.addResult([]) // name check
      mock.addResult([]) // org check: not found

      await expect(
        service.createDraft(
          { name: 'my-draft', ownerOrg: '550e8400-e29b-41d4-a716-446655440000' },
          'user-1'
        )
      ).rejects.toThrow('Organization not found')
    })
  })

  describe('publish (ADR-039)', () => {
    const ORG_ID = '550e8400-e29b-41d4-a716-446655440000'

    it('should throw NotFoundError when the package is neither draft nor active', async () => {
      mock.addResult([]) // getByNameOrId(['draft','active']) finds nothing

      await expect(service.publish('deleted-pkg')).rejects.toThrow('Package not found')
    })

    it('should return an already-active package as-is (idempotent re-publish)', async () => {
      const pkg = createPackageFixture({ state: 'active', name: 'real-name', ownerOrg: ORG_ID })
      mock.addResult([pkg]) // getByNameOrId(['draft','active'])

      // No validation / claim queries are consumed — the row is returned untouched
      const result = await service.publish(pkg.id as string)
      expect(result).toEqual(pkg)
    })

    it('should reject a placeholder name', async () => {
      const draft = createPackageFixture({
        state: 'draft',
        name: 'untitled-ab12cd34',
        ownerOrg: ORG_ID,
      })
      mock.addResult([draft])

      await expect(service.publish(draft.id as string)).rejects.toThrow(
        'Package name must be set before publishing'
      )
    })

    it('should reject a missing ownerOrg', async () => {
      const draft = createPackageFixture({ state: 'draft', name: 'real-name', ownerOrg: null })
      mock.addResult([draft])

      await expect(service.publish(draft.id as string)).rejects.toThrow(
        'Package organization must be set before publishing'
      )
    })

    it('should reject a missing licenseId', async () => {
      const draft = createPackageFixture({
        state: 'draft',
        name: 'real-name',
        ownerOrg: ORG_ID,
        licenseId: null,
      })
      mock.addResult([draft])

      await expect(service.publish(draft.id as string)).rejects.toThrow(
        'Package license must be set before publishing'
      )
    })

    it('should reject when the owner org is not active', async () => {
      const draft = createPackageFixture({
        state: 'draft',
        name: 'real-name',
        ownerOrg: ORG_ID,
        licenseId: 'cc-by',
      })
      mock.addResult([draft])
      mock.addResult([]) // org active check: not found

      await expect(service.publish(draft.id as string)).rejects.toThrow(
        'Cannot publish a package whose organization is not active'
      )
    })

    it('should throw ConflictError when the atomic claim is lost', async () => {
      const draft = createPackageFixture({
        state: 'draft',
        name: 'real-name',
        ownerOrg: ORG_ID,
        licenseId: 'cc-by',
      })
      mock.addResult([draft])
      mock.addResult([{ id: ORG_ID }]) // org active check
      mock.addResult([]) // claim UPDATE returns no row

      await expect(service.publish(draft.id as string)).rejects.toThrow(
        'Package is no longer in draft state'
      )
    })

    it('should publish a valid draft', async () => {
      const draft = createPackageFixture({
        state: 'draft',
        name: 'real-name',
        ownerOrg: ORG_ID,
        licenseId: 'cc-by',
      })
      mock.addResult([draft])
      mock.addResult([{ id: ORG_ID }]) // org active check
      mock.addResult([{ ...draft, state: 'active' }]) // claim UPDATE returning

      const result = await service.publish(draft.id as string)
      expect(result.state).toBe('active')
    })
  })

  describe('draft purge (ADR-039)', () => {
    it('should claim a draft then hard-delete it', async () => {
      const draft = createPackageFixture({ state: 'draft', name: 'untitled-ab12cd34' })
      mock.addResult([draft]) // getByNameOrId(state=draft)
      mock.addResult([{ ...draft, state: 'purging' }]) // claim update returning

      const claimed = await service.claimDraftForPurge(draft.id as string)
      expect(claimed.state).toBe('purging')

      mock.addResult([claimed]) // delete returning
      const purged = await service.finalizeDraftPurge(claimed.id as string)
      expect(purged.id).toBe(draft.id)
    })

    it('should throw NotFoundError for a non-draft package', async () => {
      mock.addResult([]) // getByNameOrId(state=draft) finds nothing

      await expect(service.claimDraftForPurge('nonexistent')).rejects.toThrow('Package not found')
    })

    it('should throw ConflictError when the claim is lost to a concurrent transition', async () => {
      const draft = createPackageFixture({ state: 'draft' })
      mock.addResult([draft]) // getByNameOrId(state=draft)
      mock.addResult([]) // claim update returns nothing — published meanwhile

      await expect(service.claimDraftForPurge(draft.id as string)).rejects.toThrow(
        'Package is no longer in draft state'
      )
    })
  })

  describe('delete', () => {
    it('should throw NotFoundError for non-existent package', async () => {
      mock.addResult([])
      await expect(service.delete('nonexistent')).rejects.toThrow('Package not found: nonexistent')
    })

    it('should return deleted package', async () => {
      const pkg = createPackageFixture()
      mock.addResult([pkg]) // getByNameOrId
      mock.addResult([{ ...pkg, state: 'deleted' }]) // update returning

      const result = await service.delete(pkg.id as string)
      expect(result.state).toBe('deleted')
    })
  })
})
