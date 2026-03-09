import { describe, it, expect, beforeEach } from 'vitest'
import { PackageService } from '../../services/package-service'
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
          owner_org: '550e8400-e29b-41d4-a716-446655440000',
          private: false,
          type: 'dataset',
          extras: {},
          tags: [],
          resources: [],
        })
      ).rejects.toThrow('Package name already exists')
    })

    it('should throw NotFoundError if owner_org does not exist', async () => {
      mock.addResult([]) // name check: no duplicate
      mock.addResult([]) // org check: not found

      await expect(
        service.create({
          name: 'new-pkg',
          owner_org: '550e8400-e29b-41d4-a716-446655440000',
          private: false,
          type: 'dataset',
          extras: {},
          tags: [],
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
        owner_org: '550e8400-e29b-41d4-a716-446655440000',
        private: false,
        type: 'dataset',
        extras: {},
        tags: [],
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
  })

  describe('patch', () => {
    it('should merge input with existing package data', async () => {
      const existing = createPackageFixture({
        name: 'old-name',
        title: 'Old Title',
        notes: 'Old notes',
      })
      // getByNameOrId query
      mock.addResult([existing])
      // update: getByNameOrId again (called from update)
      mock.addResult([existing])
      // update: name uniqueness check is skipped because name didn't change
      // update: the actual update
      mock.addResult([{ ...existing, title: 'New Title' }])

      const result = await service.patch('old-name', { title: 'New Title' })
      expect(result.title).toBe('New Title')
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
