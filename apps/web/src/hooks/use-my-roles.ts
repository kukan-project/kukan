import { useMemo } from 'react'
import { useFetch } from './use-fetch'

export type MembershipRole = 'admin' | 'editor' | 'member'

/** Mirrors the API's ROLE_HIERARCHY so these answer the same question the
 *  server does — an equality test would deny a role added above admin */
const ROLE_RANK: Record<string, number> = { admin: 3, editor: 2, member: 1 }

/** Whether a membership role satisfies `required`, for callers that already
 *  hold the role (e.g. filtering the items of a /me/* response) */
export function hasRole(role: string | undefined, required: MembershipRole): boolean {
  return (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK[required]
}

interface MembershipItem {
  id: string
  name: string
  title?: string | null
  role: MembershipRole
}

interface UseMyRolesResult {
  /** Whether the viewer holds `required` (or higher) in the entity */
  can: (nameOrId: string, required: MembershipRole) => boolean
  /** False until the memberships are known — do not offer actions before then */
  ready: boolean
  /** The memberships themselves, for callers that also list them (filter options) */
  items: MembershipItem[]
}

/**
 * The viewer's role in each organization or group they belong to. Sysadmins
 * come back as admin everywhere, so callers gate on the role alone and need no
 * separate sysadmin branch.
 *
 * The dashboard lists every organization and category, but editing one needs
 * admin in it and its member list needs any role at all — without this the
 * actions were offered to everyone and only failed at the API (kukan#258).
 */
export function useMyRoles(kind: 'organizations' | 'groups'): UseMyRolesResult {
  const { data, loading } = useFetch<{ items: MembershipItem[] }>(`/api/v1/users/me/${kind}`)

  const items = useMemo(() => data?.items ?? [], [data])

  // Keyed by both, since routes address entities by either (`/[nameOrId]/edit`)
  const roles = useMemo(() => {
    const map = new Map<string, MembershipRole>()
    for (const item of items) {
      map.set(item.id, item.role)
      map.set(item.name, item.role)
    }
    return map
  }, [items])

  return {
    can: (nameOrId, required) => hasRole(roles.get(nameOrId), required),
    ready: !loading,
    items,
  }
}
