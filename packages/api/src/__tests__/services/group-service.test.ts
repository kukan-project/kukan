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

  describe('update', () => {
    it('should update and return the group', async () => {
      const grp = createGroupFixture()
      mock.addResult([grp]) // getByNameOrId
      mock.addResult([{ ...grp, title: 'Updated Title' }]) // update returning

      const result = await service.update('test-group', { title: 'Updated Title' })
      expect(result.title).toBe('Updated Title')
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

  describe('listMembers', () => {
    it('should return members with user info', async () => {
      mock.addResult([
        {
          id: 'mem-1',
          userId: 'user-1',
          role: 'editor',
          created: new Date(),
          userName: 'bob',
          email: 'bob@example.com',
          displayName: 'Bob',
        },
      ])

      const result = await service.listMembers('grp-1')
      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('editor')
      expect(result[0].email).toBe('bob@example.com')
    })

    it('should return empty array when no members', async () => {
      mock.addResult([])
      const result = await service.listMembers('grp-1')
      expect(result).toEqual([])
    })
  })

  describe('addMember', () => {
    it('should create new membership', async () => {
      mock.addResult([{ id: 'user-1' }]) // user exists
      mock.addResult([]) // no existing membership
      mock.addResult([{ id: 'mem-1', userId: 'user-1', groupId: 'grp-1', role: 'member' }])

      const result = await service.addMember('grp-1', 'user-1')
      expect(result.role).toBe('member')
    })

    it('should update role if already a member', async () => {
      mock.addResult([{ id: 'user-1' }]) // user exists
      mock.addResult([{ id: 'mem-1' }]) // existing membership
      mock.addResult([{ id: 'mem-1', role: 'admin' }]) // update returning

      const result = await service.addMember('grp-1', 'user-1', 'admin')
      expect(result.role).toBe('admin')
    })

    it('should throw NotFoundError if user does not exist', async () => {
      mock.addResult([]) // user not found

      await expect(service.addMember('grp-1', 'no-user')).rejects.toThrow('User not found: no-user')
    })
  })

  describe('removeMember', () => {
    it('should remove membership and return success', async () => {
      mock.addResult([{ id: 'mem-1' }]) // delete returning

      const result = await service.removeMember('grp-1', 'user-1')
      expect(result).toEqual({ success: true })
    })

    it('should throw NotFoundError when membership does not exist', async () => {
      mock.addResult([]) // delete returns nothing

      await expect(service.removeMember('grp-1', 'no-user')).rejects.toThrow('Membership not found')
    })
  })
})
