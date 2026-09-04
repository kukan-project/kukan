import 'server-only'

import { cache } from 'react'
import { serverFetch } from './server-api'
import type { Package } from '@/components/dataset-detail-layout'

/**
 * Cached catalog reads. Deduped per request so a route's `generateMetadata`
 * and its page component share one fetch.
 */

export interface Entity {
  name: string
  title?: string | null
  description?: string | null
}

async function fetchJson(path: string) {
  const res = await serverFetch(path).catch(() => null)
  if (!res?.ok) return null
  return res.json()
}

export const getPackage = cache(
  (nameOrId: string) =>
    fetchJson(`/api/v1/packages/${encodeURIComponent(nameOrId)}`) as Promise<Package | null>
)

export const getEntity = cache(
  (kind: 'organizations' | 'groups', nameOrId: string) =>
    fetchJson(`/api/v1/${kind}/${encodeURIComponent(nameOrId)}`) as Promise<Entity | null>
)

export async function getResource(nameOrId: string, resourceId: string) {
  const pkg = await getPackage(nameOrId)
  return pkg?.resources?.find((r) => r.id === resourceId) ?? null
}
