import { describe, it, expect } from 'vitest'
import { ForbiddenError } from '@kukan/shared'
import { createMockDb } from '../test-helpers/mock-db'
import { checkOrgRole, checkGroupRole, checkOwnerOrSysadmin } from '../../auth/permissions'

const normalUser = { id: 'user-1', sysadmin: false }
const sysadminUser = { id: 'admin-1', sysadmin: true }

describe('checkOwnerOrSysadmin', () => {
  it('should pass for sysadmin regardless of ownership', () => {
    expect(() => checkOwnerOrSysadmin(sysadminUser, 'other-user')).not.toThrow()
    expect(() => checkOwnerOrSysadmin(sysadminUser, null)).not.toThrow()
  })

  it('should pass when user is the owner', () => {
    expect(() => checkOwnerOrSysadmin(normalUser, normalUser.id)).not.toThrow()
  })

  it('should throw ForbiddenError when user is not owner', () => {
    expect(() => checkOwnerOrSysadmin(normalUser, 'other-user')).toThrow(ForbiddenError)
  })

  it('should throw ForbiddenError when ownerId is null', () => {
    expect(() => checkOwnerOrSysadmin(normalUser, null)).toThrow(ForbiddenError)
  })
})

describe('checkOrgRole', () => {
  it('should pass for sysadmin without DB lookup', async () => {
    const { db } = createMockDb()
    await expect(checkOrgRole(db, sysadminUser, 'org-1', 'admin')).resolves.toBeUndefined()
  })

  it('should pass when user has required role', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'admin' }])
    await expect(checkOrgRole(db, normalUser, 'org-1', 'admin')).resolves.toBeUndefined()
  })

  it('should pass when user has higher role than required', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'admin' }])
    await expect(checkOrgRole(db, normalUser, 'org-1', 'editor')).resolves.toBeUndefined()
  })

  it('should pass for editor when editor is required', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'editor' }])
    await expect(checkOrgRole(db, normalUser, 'org-1', 'editor')).resolves.toBeUndefined()
  })

  it('should throw when user has lower role than required', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'member' }])
    await expect(checkOrgRole(db, normalUser, 'org-1', 'editor')).rejects.toThrow(ForbiddenError)
  })

  it('should throw when user is not a member', async () => {
    const { db, addResult } = createMockDb()
    addResult([]) // no membership found
    await expect(checkOrgRole(db, normalUser, 'org-1', 'member')).rejects.toThrow(
      'Not a member of this organization'
    )
  })
})

describe('checkGroupRole', () => {
  it('should pass for sysadmin without DB lookup', async () => {
    const { db } = createMockDb()
    await expect(checkGroupRole(db, sysadminUser, 'grp-1', 'admin')).resolves.toBeUndefined()
  })

  it('should pass when user has required role', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'editor' }])
    await expect(checkGroupRole(db, normalUser, 'grp-1', 'member')).resolves.toBeUndefined()
  })

  it('should throw when user is not a member', async () => {
    const { db, addResult } = createMockDb()
    addResult([])
    await expect(checkGroupRole(db, normalUser, 'grp-1', 'member')).rejects.toThrow(
      'Not a member of this group'
    )
  })

  it('should throw when role is insufficient', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'member' }])
    await expect(checkGroupRole(db, normalUser, 'grp-1', 'admin')).rejects.toThrow(
      'Requires admin role or higher'
    )
  })
})
