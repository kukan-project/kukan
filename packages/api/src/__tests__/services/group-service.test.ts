import { describe, it, expect, beforeEach } from 'vitest'
import { GroupService } from '../../services/group-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createGroupFixture } from '../test-helpers/fixtures'

describe('GroupService', () => {
  let service: GroupService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new GroupService(mock.db)
  })

  describe('list', () => {
    it('should return paginated result', async () => {
      mock.addResult([])

      const result = await service.list({ offset: 0, limit: 20 })
      expect(result.total).toBe(0)
      expect(result.items).toEqual([])
    })
  })

  describe('getByNameOrId', () => {
    it('should return group when found by name', async () => {
      const group = createGroupFixture({ name: 'my-group' })
      mock.addResult([group])

      const result = await service.getByNameOrId('my-group')
      expect(result.name).toBe('my-group')
    })

    it('should return group when found by UUID', async () => {
      const group = createGroupFixture()
      mock.addResult([group])

      const result = await service.getByNameOrId(group.id as string)
      expect(result.id).toBe(group.id)
    })

    it('should throw NotFoundError when not found', async () => {
      mock.addResult([])
      await expect(service.getByNameOrId('nonexistent')).rejects.toThrow(
        'Group not found: nonexistent'
      )
    })
  })

  describe('create', () => {
    it('should throw ValidationError if name already exists', async () => {
      mock.addResult([createGroupFixture()])
      await expect(service.create({ name: 'duplicate' })).rejects.toThrow(
        'Group name already exists'
      )
    })

    it('should create group successfully', async () => {
      const created = createGroupFixture({ name: 'new-group' })
      mock.addResult([]) // name check
      mock.addResult([created]) // insert returning

      const result = await service.create({ name: 'new-group' })
      expect(result.name).toBe('new-group')
    })
  })

  describe('delete', () => {
    it('should soft delete the group', async () => {
      const group = createGroupFixture()
      mock.addResult([group]) // getByNameOrId
      mock.addResult(undefined as never) // update

      const result = await service.delete('test-group')
      expect(result).toEqual({ success: true })
    })
  })
})
