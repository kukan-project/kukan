/**
 * KUKAN Permission Checks
 * Helpers for authorization logic
 */

import { eq, and } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { userOrgMembership } from '@kukan/db'
import { ForbiddenError } from '@kukan/shared'

export type OrgRole = 'admin' | 'editor' | 'member'

interface AuthUser {
  id: string
  sysadmin: boolean
}

/**
 * Check if a user has a specific role (or higher) in an organization.
 * Role hierarchy: admin > editor > member
 */
export async function checkOrgRole(
  db: Database,
  user: AuthUser,
  organizationId: string,
  requiredRole: OrgRole
): Promise<void> {
  // Sysadmins bypass all permission checks
  if (user.sysadmin) return

  const [membership] = await db
    .select({ role: userOrgMembership.role })
    .from(userOrgMembership)
    .where(
      and(
        eq(userOrgMembership.userId, user.id),
        eq(userOrgMembership.organizationId, organizationId)
      )
    )
    .limit(1)

  if (!membership) {
    throw new ForbiddenError('Not a member of this organization')
  }

  const roleHierarchy: Record<string, number> = {
    admin: 3,
    editor: 2,
    member: 1,
  }

  const userLevel = roleHierarchy[membership.role] ?? 0
  const requiredLevel = roleHierarchy[requiredRole] ?? 0

  if (userLevel < requiredLevel) {
    throw new ForbiddenError(`Requires ${requiredRole} role or higher`)
  }
}

/**
 * Check if a user is the owner (creator) of a resource, or a sysadmin.
 */
export function checkOwnerOrSysadmin(user: AuthUser, ownerId: string | null): void {
  if (user.sysadmin) return
  if (ownerId && user.id === ownerId) return
  throw new ForbiddenError('Only the owner or sysadmin can perform this action')
}
