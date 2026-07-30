import { describe, it, expect, beforeEach } from 'vitest'
import { ResourceService } from '../../services/resource-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createResourceFixture, createPackageFixture } from '../test-helpers/fixtures'

describe('ResourceService', () => {
  let service: ResourceService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new ResourceService(mock.db)
  })

  describe('listByPackage', () => {
    it('should throw NotFoundError if package does not exist', async () => {
      mock.addResult([]) // package check
      await expect(service.listByPackage('nonexistent-id')).rejects.toThrow('Package not found')
    })

    it('should return resources when package exists', async () => {
      const pkg = createPackageFixture()
      const res = createResourceFixture({ packageId: pkg.id })
      mock.addResult([pkg]) // package check
      mock.addResult([res]) // resources query

      const result = await service.listByPackage(pkg.id as string)
      expect(result).toHaveLength(1)
    })
  })

  describe('getById', () => {
    it('should return resource when found', async () => {
      const res = createResourceFixture()
      mock.addResult([res])

      const result = await service.getById(res.id as string)
      expect(result.id).toBe(res.id)
    })

    it('should throw NotFoundError when not found', async () => {
      mock.addResult([])
      await expect(service.getById('nonexistent')).rejects.toThrow(
        'Resource not found: nonexistent'
      )
    })
  })

  describe('getByIdWithAccessCheck', () => {
    it('should return resource when parent package is public', async () => {
      const res = createResourceFixture()
      // JOIN query returns resource + package columns in a single row
      mock.addResult([{ resource: res, pkgPrivate: false, pkgOwnerOrg: null }])

      const result = await service.getByIdWithAccessCheck(res.id as string)
      expect(result.id).toBe(res.id)
    })

    it('should return resource when private but viewer is org member', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111'
      const res = createResourceFixture()
      mock.addResult([{ resource: res, pkgPrivate: true, pkgOwnerOrg: orgId }]) // JOIN query
      mock.addResult([{ id: 'membership-id' }]) // hasOrgMembership check

      const result = await service.getByIdWithAccessCheck(res.id as string, {
        id: 'user-1',
        sysadmin: false,
      })
      expect(result.id).toBe(res.id)
    })

    it('should return resource when private but viewer is sysadmin', async () => {
      const res = createResourceFixture()
      mock.addResult([{ resource: res, pkgPrivate: true, pkgOwnerOrg: 'org-1' }]) // JOIN query

      const result = await service.getByIdWithAccessCheck(res.id as string, {
        id: 'admin-1',
        sysadmin: true,
      })
      expect(result.id).toBe(res.id)
    })

    it('should throw NotFoundError when private and viewer is unauthenticated', async () => {
      const res = createResourceFixture()
      mock.addResult([{ resource: res, pkgPrivate: true, pkgOwnerOrg: 'org-1' }]) // JOIN query

      await expect(service.getByIdWithAccessCheck(res.id as string)).rejects.toThrow(
        'Resource not found'
      )
    })

    it('should throw NotFoundError when private and viewer is not org member', async () => {
      const res = createResourceFixture()
      mock.addResult([{ resource: res, pkgPrivate: true, pkgOwnerOrg: 'org-1' }]) // JOIN query
      mock.addResult([]) // hasOrgMembership — no membership

      await expect(
        service.getByIdWithAccessCheck(res.id as string, { id: 'outsider', sysadmin: false })
      ).rejects.toThrow('Resource not found')
    })

    it('should throw NotFoundError when resource or parent package does not exist', async () => {
      mock.addResult([]) // JOIN query — no row

      await expect(service.getByIdWithAccessCheck('nonexistent')).rejects.toThrow(
        'Resource not found'
      )
    })
  })

  describe('create', () => {
    it('should throw NotFoundError if package does not exist', async () => {
      mock.addResult([]) // advisory lock
      mock.addResult([]) // package check
      await expect(
        service.create({ packageId: '550e8400-e29b-41d4-a716-446655440000' })
      ).rejects.toThrow('Package not found')
    })

    it('should create resource with auto-assigned position', async () => {
      const pkg = createPackageFixture()
      const created = createResourceFixture({ position: 0 })
      mock.addResult([]) // advisory lock
      mock.addResult([pkg]) // package check
      mock.addResult([{ maxPosition: -1 }]) // max position query
      mock.addResult([created]) // insert returning

      const result = await service.create({ packageId: pkg.id as string })
      expect(result.position).toBe(0)
    })
  })

  describe('update', () => {
    it('should throw NotFoundError when resource not found', async () => {
      mock.addResult([]) // getById
      await expect(service.update('nonexistent', { name: 'anything' })).rejects.toThrow(
        'Resource not found'
      )
    })
  })

  describe('delete', () => {
    it('should soft delete the resource', async () => {
      const res = createResourceFixture()
      mock.addResult([res]) // getById
      mock.addResult([{ ...res, state: 'deleted' }]) // update returning

      const result = await service.delete(res.id as string)
      expect(result.state).toBe('deleted')
    })
  })
})
