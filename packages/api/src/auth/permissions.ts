/**
 * KUKAN Permission Checks
 * Helpers for authorization logic
 */

import { eq, and } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { userOrgMembership, userGroupMembership } from '@kukan/db'
import { ForbiddenError } from '@kukan/shared'

export type MembershipRole = 'admin' | 'editor' | 'member'

interface AuthUser {
  id: string
  sysadmin: boolean
}

const ROLE_HIERARCHY: Record<string, number> = {
  admin: 3,
  editor: 2,
  member: 1,
}

/**
 * Generic membership role check.
 * Verifies a user has the required role (or higher) in a membership table.
 */
async function checkMembershipRole(
  db: Database,
  user: AuthUser,
  entityId: string,
  requiredRole: MembershipRole,
  config: {
    table: typeof userOrgMembership | typeof userGroupMembership
    userIdCol: typeof userOrgMembership.userId | typeof userGroupMembership.userId
    entityIdCol: typeof userOrgMembership.organizationId | typeof userGroupMembership.groupId
    roleCol: typeof userOrgMembership.role | typeof userGroupMembership.role
    entityLabel: string
  }
): Promise<void> {
  if (user.sysadmin) return

  const [membership] = await db
    .select({ role: config.roleCol })
    .from(config.table)
    .where(and(eq(config.userIdCol, user.id), eq(config.entityIdCol, entityId)))
    .limit(1)

  if (!membership) {
    throw new ForbiddenError(`Not a member of this ${config.entityLabel}`)
  }

  const userLevel = ROLE_HIERARCHY[membership.role] ?? 0
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 0

  if (userLevel < requiredLevel) {
    throw new ForbiddenError(`Requires ${requiredRole} role or higher`)
  }
}

/**
 * Check if a user has a specific role (or higher) in an organization.
 */
export async function checkOrgRole(
  db: Database,
  user: AuthUser,
  organizationId: string,
  requiredRole: MembershipRole
): Promise<void> {
  return checkMembershipRole(db, user, organizationId, requiredRole, {
    table: userOrgMembership,
    userIdCol: userOrgMembership.userId,
    entityIdCol: userOrgMembership.organizationId,
    roleCol: userOrgMembership.role,
    entityLabel: 'organization',
  })
}

/**
 * Check if a user has a specific role (or higher) in a group.
 */
export async function checkGroupRole(
  db: Database,
  user: AuthUser,
  groupId: string,
  requiredRole: MembershipRole
): Promise<void> {
  return checkMembershipRole(db, user, groupId, requiredRole, {
    table: userGroupMembership,
    userIdCol: userGroupMembership.userId,
    entityIdCol: userGroupMembership.groupId,
    roleCol: userGroupMembership.role,
    entityLabel: 'group',
  })
}

/**
 * Check if a user is the owner (creator) of a resource, or a sysadmin.
 */
export function checkOwnerOrSysadmin(user: AuthUser, ownerId: string | null): void {
  if (user.sysadmin) return
  if (ownerId && user.id === ownerId) return
  throw new ForbiddenError('Only the owner or sysadmin can perform this action')
}
