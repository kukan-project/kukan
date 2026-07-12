import { describe, it, expect } from 'vitest'
import { ForbiddenError } from '@kukan/shared'
import { createMockDb } from '../test-helpers/mock-db'
import {
  checkOrgRole,
  checkGroupRole,
  checkOwnerOrSysadmin,
  hasOrgRole,
  hasDraftAccess,
} from '../../auth/permissions'

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
      'Requires member role or higher in this organization'
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
      'Requires member role or higher in this group'
    )
  })

  it('should throw when role is insufficient', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'member' }])
    await expect(checkGroupRole(db, normalUser, 'grp-1', 'admin')).rejects.toThrow(
      'Requires admin role or higher in this group'
    )
  })
})

describe('hasOrgRole', () => {
  it('should return true for sysadmin without DB lookup', async () => {
    const { db } = createMockDb()
    expect(await hasOrgRole(db, sysadminUser, 'org-1', 'editor')).toBe(true)
  })

  it('should return true when role meets the requirement', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'admin' }])
    expect(await hasOrgRole(db, normalUser, 'org-1', 'editor')).toBe(true)
  })

  it('should return false when role is below the requirement', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'member' }])
    expect(await hasOrgRole(db, normalUser, 'org-1', 'editor')).toBe(false)
  })

  it('should return false without membership', async () => {
    const { db, addResult } = createMockDb()
    addResult([])
    expect(await hasOrgRole(db, normalUser, 'org-1', 'editor')).toBe(false)
  })
})

describe('hasDraftAccess (ADR-039)', () => {
  const draft = { creatorUserId: 'creator-1', ownerOrg: null }

  it('should deny anonymous viewers', async () => {
    const { db } = createMockDb()
    expect(await hasDraftAccess(db, draft, undefined)).toBe(false)
  })

  it('should allow sysadmin', async () => {
    const { db } = createMockDb()
    expect(await hasDraftAccess(db, draft, sysadminUser)).toBe(true)
  })

  it('should allow the creator', async () => {
    const { db } = createMockDb()
    expect(await hasDraftAccess(db, draft, { id: 'creator-1', sysadmin: false })).toBe(true)
  })

  it('should deny other users when no ownerOrg is set', async () => {
    const { db } = createMockDb()
    expect(await hasDraftAccess(db, draft, normalUser)).toBe(false)
  })

  it('should allow an editor of the owner org', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'editor' }])
    const pkg = { creatorUserId: 'creator-1', ownerOrg: 'org-1' }
    expect(await hasDraftAccess(db, pkg, normalUser)).toBe(true)
  })

  it('should deny a plain member of the owner org', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ role: 'member' }])
    const pkg = { creatorUserId: 'creator-1', ownerOrg: 'org-1' }
    expect(await hasDraftAccess(db, pkg, normalUser)).toBe(false)
  })
})
