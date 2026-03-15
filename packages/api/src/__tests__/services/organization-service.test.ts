import { describe, it, expect, beforeEach } from 'vitest'
import { OrganizationService } from '../../services/organization-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createOrganizationFixture } from '../test-helpers/fixtures'

describe('OrganizationService', () => {
  let service: OrganizationService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new OrganizationService(mock.db)
  })

  describe('list', () => {
    it('should return paginated result', async () => {
      const org = { ...createOrganizationFixture(), total: 1 }
      mock.addResult([org])

      const result = await service.list({ offset: 0, limit: 20 })
      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
    })
  })

  describe('getByNameOrId', () => {
    it('should return organization when found', async () => {
      const org = createOrganizationFixture({ name: 'my-org' })
      mock.addResult([org])

      const result = await service.getByNameOrId('my-org')
      expect(result.name).toBe('my-org')
    })

    it('should throw NotFoundError when not found', async () => {
      mock.addResult([])
      await expect(service.getByNameOrId('nonexistent')).rejects.toThrow(
        'Organization not found: nonexistent'
      )
    })
  })

  describe('create', () => {
    it('should throw ValidationError if name already exists', async () => {
      mock.addResult([createOrganizationFixture()])
      await expect(service.create({ name: 'duplicate' })).rejects.toThrow(
        'Organization name already exists'
      )
    })

    it('should create organization successfully', async () => {
      const created = createOrganizationFixture({ name: 'new-org' })
      mock.addResult([]) // name check
      mock.addResult([created]) // insert returning

      const result = await service.create({ name: 'new-org' })
      expect(result.name).toBe('new-org')
    })
  })

  describe('update', () => {
    it('should update and return the organization', async () => {
      const org = createOrganizationFixture()
      mock.addResult([org]) // getByNameOrId
      mock.addResult([{ ...org, title: 'Updated' }]) // update returning

      const result = await service.update('test-org', { title: 'Updated' })
      expect(result.title).toBe('Updated')
    })
  })

  describe('delete', () => {
    it('should soft delete the organization', async () => {
      const org = createOrganizationFixture()
      mock.addResult([org]) // getByNameOrId
      mock.addResult(undefined as never) // update (no returning)

      const result = await service.delete('test-org')
      expect(result).toEqual({ success: true })
    })
  })
})
