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

/**
 * Resolve organization IDs that the user belongs to.
 * Returns `undefined` for unauthenticated users and sysadmins (no restriction needed).
 */
export async function resolveUserOrgIds(
  db: Database,
  user: AuthUser | undefined
): Promise<string[] | undefined> {
  if (!user || user.sysadmin) return undefined
  const memberships = await db
    .select({ organizationId: userOrgMembership.organizationId })
    .from(userOrgMembership)
    .where(eq(userOrgMembership.userId, user.id))
  return memberships.map((m) => m.organizationId)
}

/**
 * Build visibility filters for SearchAdapter based on user context.
 * Mirrors the visibility logic used across packages, resources, search, and CKAN-compat routes.
 */
export function buildVisibilityFilters(
  user: AuthUser | undefined,
  userOrgIds: string[] | undefined
): { excludePrivate?: boolean; allowPrivateOrgIds?: string[] } {
  if (user?.sysadmin) return {}
  return {
    excludePrivate: true,
    ...(userOrgIds?.length && { allowPrivateOrgIds: userOrgIds }),
  }
}
