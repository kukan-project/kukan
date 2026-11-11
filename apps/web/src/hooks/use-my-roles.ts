import { useMemo } from 'react'
import { hasRole, type MembershipRole } from '@/lib/roles'
import { useFetch } from './use-fetch'

// Kept here for the pages that already import them with the hook; the
// definitions live in lib so a server component can use them without the hook
export { hasRole, type MembershipRole }

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
 * actions were offered to everyone and only failed at the API.
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
