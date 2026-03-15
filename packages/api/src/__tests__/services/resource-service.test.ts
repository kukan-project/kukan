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

  describe('create', () => {
    it('should throw NotFoundError if package does not exist', async () => {
      mock.addResult([]) // package check
      await expect(
        service.create({ package_id: '550e8400-e29b-41d4-a716-446655440000', extras: {} })
      ).rejects.toThrow('Package not found')
    })

    it('should create resource with auto-assigned position', async () => {
      const pkg = createPackageFixture()
      const created = createResourceFixture({ position: 0 })
      mock.addResult([pkg]) // package check
      mock.addResult([{ maxPosition: -1 }]) // max position query
      mock.addResult([created]) // insert returning

      const result = await service.create({ package_id: pkg.id as string, extras: {} })
      expect(result.position).toBe(0)
    })
  })

  describe('update', () => {
    it('should throw NotFoundError when resource not found', async () => {
      mock.addResult([]) // getById
      await expect(service.update('nonexistent', {})).rejects.toThrow('Resource not found')
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
