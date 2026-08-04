/**
 * KUKAN Permission Checks
 * Helpers for authorization logic
 */

import { eq, and, inArray } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { userOrgMembership, userGroupMembership } from '@kukan/db'
import { ForbiddenError } from '@kukan/shared'

export type MembershipRole = 'admin' | 'editor' | 'member'

export interface AuthUser {
  id: string
  sysadmin: boolean
}

const ROLE_HIERARCHY: Record<string, number> = {
  admin: 3,
  editor: 2,
  member: 1,
}

interface MembershipConfig {
  table: typeof userOrgMembership | typeof userGroupMembership
  userIdCol: typeof userOrgMembership.userId | typeof userGroupMembership.userId
  entityIdCol: typeof userOrgMembership.organizationId | typeof userGroupMembership.groupId
  roleCol: typeof userOrgMembership.role | typeof userGroupMembership.role
  entityLabel: string
}

const ORG_MEMBERSHIP: MembershipConfig = {
  table: userOrgMembership,
  userIdCol: userOrgMembership.userId,
  entityIdCol: userOrgMembership.organizationId,
  roleCol: userOrgMembership.role,
  entityLabel: 'organization',
}

const GROUP_MEMBERSHIP: MembershipConfig = {
  table: userGroupMembership,
  userIdCol: userGroupMembership.userId,
  entityIdCol: userGroupMembership.groupId,
  roleCol: userGroupMembership.role,
  entityLabel: 'group',
}

/**
 * Core membership check: true when the user has the required role (or higher)
 * in a membership table. Sysadmins always pass.
 */
async function hasMembershipRole(
  db: Database,
  user: AuthUser,
  entityId: string,
  requiredRole: MembershipRole,
  config: MembershipConfig
): Promise<boolean> {
  if (user.sysadmin) return true

  const [membership] = await db
    .select({ role: config.roleCol })
    .from(config.table)
    .where(and(eq(config.userIdCol, user.id), eq(config.entityIdCol, entityId)))
    .limit(1)

  if (!membership) return false
  return (ROLE_HIERARCHY[membership.role] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0)
}

/** Throwing variant of {@link hasMembershipRole}. */
async function checkMembershipRole(
  db: Database,
  user: AuthUser,
  entityId: string,
  requiredRole: MembershipRole,
  config: MembershipConfig
): Promise<void> {
  if (!(await hasMembershipRole(db, user, entityId, requiredRole, config))) {
    throw new ForbiddenError(
      `Requires ${requiredRole} role or higher in this ${config.entityLabel}`
    )
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
  return checkMembershipRole(db, user, organizationId, requiredRole, ORG_MEMBERSHIP)
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
  return checkMembershipRole(db, user, groupId, requiredRole, GROUP_MEMBERSHIP)
}

/**
 * Boolean variant of {@link checkOrgRole} — true when the user has the required
 * role (or higher) in the organization. Sysadmins always pass.
 */
export async function hasOrgRole(
  db: Database,
  viewer: AuthUser,
  organizationId: string,
  requiredRole: MembershipRole
): Promise<boolean> {
  return hasMembershipRole(db, viewer, organizationId, requiredRole, ORG_MEMBERSHIP)
}

/**
 * Draft package access (view/edit/delete/publish, ADR-039): the creator,
 * sysadmins, and — once ownerOrg is set — that organization's editors.
 */
export async function hasDraftAccess(
  db: Database,
  pkg: { creatorUserId: string | null; ownerOrg: string | null },
  viewer?: AuthUser
): Promise<boolean> {
  if (!viewer) return false
  if (viewer.sysadmin) return true
  if (pkg.creatorUserId && viewer.id === pkg.creatorUserId) return true
  if (pkg.ownerOrg) return hasOrgRole(db, viewer, pkg.ownerOrg, 'editor')
  return false
}

interface PackageOwnership {
  state: string | null
  ownerOrg: string | null
  creatorUserId: string | null
}

/**
 * The package write rule, as a reason string or null when allowed. Draft access
 * is creator-based (ADR-039); org role applies otherwise. 'purging' rows are
 * drafts whose purge crashed mid-flight, so the same draft rule lets the DELETE
 * be re-run to finish the cleanup.
 */
async function packageWriteDenial(
  db: Database,
  user: AuthUser,
  pkg: PackageOwnership,
  role: MembershipRole
): Promise<string | null> {
  if (pkg.state === 'draft' || pkg.state === 'purging') {
    return (await hasDraftAccess(db, pkg, user)) ? null : 'No access to this draft package'
  }
  if (pkg.ownerOrg) {
    return (await hasOrgRole(db, user, pkg.ownerOrg, role))
      ? null
      : `Requires ${role} role or higher in this organization`
  }
  return user.sysadmin ? null : 'Only sysadmin can modify packages without an organization'
}

/**
 * Boolean variant of {@link makePackageAuthorize}, for callers that shape a
 * response rather than reject a request.
 */
export async function canWritePackage(
  db: Database,
  user: AuthUser,
  pkg: PackageOwnership,
  role: MembershipRole
): Promise<boolean> {
  return (await packageWriteDenial(db, user, pkg, role)) === null
}

/**
 * Standard package write authorization, shaped for PackageService's
 * `authorize` callbacks and reused for resource mutations.
 */
export function makePackageAuthorize(db: Database, user: AuthUser, role: MembershipRole) {
  return async (existing: PackageOwnership): Promise<void> => {
    const denial = await packageWriteDenial(db, user, existing, role)
    if (denial) throw new ForbiddenError(denial)
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

/**
 * Check if a viewer has membership in a given organization.
 * Sysadmins always pass. Returns false for anonymous viewers or missing ownerOrg.
 */
export async function hasOrgMembership(
  db: Database,
  ownerOrg: string | null,
  viewer?: AuthUser
): Promise<boolean> {
  if (viewer?.sysadmin) return true
  if (!viewer?.id || !ownerOrg) return false

  const [membership] = await db
    .select({ id: userOrgMembership.id })
    .from(userOrgMembership)
    .where(
      and(eq(userOrgMembership.userId, viewer.id), eq(userOrgMembership.organizationId, ownerOrg))
    )
    .limit(1)

  return !!membership
}

/**
 * Resolve organization IDs that the user belongs to, optionally restricted to
 * memberships with `minRole` or higher (e.g. 'editor' for draft visibility, ADR-039).
 * Returns `undefined` for unauthenticated users and sysadmins (no restriction needed).
 */
export async function resolveUserOrgIds(
  db: Database,
  user: AuthUser | undefined,
  minRole?: MembershipRole
): Promise<string[] | undefined> {
  if (!user || user.sysadmin) return undefined
  const roles = minRole
    ? Object.keys(ROLE_HIERARCHY).filter((r) => ROLE_HIERARCHY[r] >= ROLE_HIERARCHY[minRole])
    : undefined
  const memberships = await db
    .select({ organizationId: userOrgMembership.organizationId })
    .from(userOrgMembership)
    .where(
      roles
        ? and(eq(userOrgMembership.userId, user.id), inArray(userOrgMembership.role, roles))
        : eq(userOrgMembership.userId, user.id)
    )
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
