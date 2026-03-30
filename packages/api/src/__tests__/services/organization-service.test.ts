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

  describe('listMembers', () => {
    it('should return members with user info', async () => {
      mock.addResult([
        {
          id: 'mem-1',
          userId: 'user-1',
          role: 'admin',
          created: new Date(),
          userName: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice',
        },
      ])

      const result = await service.listMembers('org-1')
      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('admin')
      expect(result[0].userName).toBe('alice')
    })

    it('should return empty array when no members', async () => {
      mock.addResult([])
      const result = await service.listMembers('org-1')
      expect(result).toEqual([])
    })
  })

  describe('addMember', () => {
    it('should create new membership', async () => {
      mock.addResult([{ id: 'user-1' }]) // user exists check
      mock.addResult([]) // no existing membership
      mock.addResult([{ id: 'mem-1', userId: 'user-1', organizationId: 'org-1', role: 'editor' }])

      const result = await service.addMember('org-1', 'user-1', 'editor')
      expect(result.role).toBe('editor')
    })

    it('should update role if user is already a member', async () => {
      mock.addResult([{ id: 'user-1' }]) // user exists
      mock.addResult([{ id: 'mem-1' }]) // existing membership found
      mock.addResult([{ id: 'mem-1', role: 'admin' }]) // update returning

      const result = await service.addMember('org-1', 'user-1', 'admin')
      expect(result.role).toBe('admin')
    })

    it('should throw NotFoundError if user does not exist', async () => {
      mock.addResult([]) // user not found

      await expect(service.addMember('org-1', 'no-user', 'member')).rejects.toThrow(
        'User not found: no-user'
      )
    })

    it('should default role to member', async () => {
      mock.addResult([{ id: 'user-1' }]) // user exists
      mock.addResult([]) // no existing membership
      mock.addResult([{ id: 'mem-1', userId: 'user-1', organizationId: 'org-1', role: 'member' }])

      const result = await service.addMember('org-1', 'user-1')
      expect(result.role).toBe('member')
    })
  })

  describe('removeMember', () => {
    it('should remove membership and return success', async () => {
      mock.addResult([{ id: 'mem-1' }]) // delete returning

      const result = await service.removeMember('org-1', 'user-1')
      expect(result).toEqual({ success: true })
    })

    it('should throw NotFoundError when membership does not exist', async () => {
      mock.addResult([]) // delete returns nothing

      await expect(service.removeMember('org-1', 'no-user')).rejects.toThrow('Membership not found')
    })
  })
})
