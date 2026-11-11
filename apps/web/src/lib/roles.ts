export type MembershipRole = 'admin' | 'editor' | 'member'

/** Mirrors the API's ROLE_HIERARCHY so these answer the same question the
 *  server does — an equality test would deny a role added above admin */
const ROLE_RANK: Record<string, number> = { admin: 3, editor: 2, member: 1 }

/** Whether a membership role satisfies `required`, for callers that already
 *  hold the role (e.g. filtering the items of a /me/* response) */
export function hasRole(role: string | undefined, required: MembershipRole): boolean {
  return (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK[required]
}

/**
 * Whether the viewer may edit a dataset — the API's package write rule at
 * editor (`packageWriteDenial`), so a screen offers editing only to someone
 * whose saves would go through. Membership alone is not it: a `member` can read
 * a private dataset but not change it.
 *
 * `ownerOrgRole` is the viewer's role in the dataset's organization, as
 * `/users/me/organizations` reports it.
 */
export function canEditPackage(
  viewer: { id: string; sysadmin: boolean },
  pkg: { state?: string | null; ownerOrg?: string | null; creatorUserId?: string | null },
  ownerOrgRole: string | undefined
): boolean {
  if (viewer.sysadmin) return true
  // A draft is also its creator's, with or without an organization (ADR-039)
  const draft = pkg.state === 'draft' || pkg.state === 'purging'
  if (draft && !!pkg.creatorUserId && pkg.creatorUserId === viewer.id) return true
  return !!pkg.ownerOrg && hasRole(ownerOrgRole, 'editor')
}
