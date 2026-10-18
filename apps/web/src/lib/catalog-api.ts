import 'server-only'

import { cache } from 'react'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from './server-api'
import type { Package } from '@/components/dataset/dataset-detail-layout'
import type { DatasetCardItem } from '@/components/dataset/dataset-card'

/**
 * Cached catalog reads. Deduped per request so a route's `generateMetadata`
 * and its page component share one fetch.
 */

export interface Entity {
  name: string
  title?: string | null
  description?: string | null
}

/**
 * `null` only when the API says 404 (it answers 404 for what the viewer may not
 * see, too). Any other failure throws, so an outage reaches the error boundary
 * instead of rendering an existing entity as not found.
 */
async function fetchJson(path: string) {
  const res = await serverFetch(path)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}`)
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

/** A page of the dataset search — the one `/dataset` runs */
export function searchPackages(query: URLSearchParams) {
  return fetchJson(`/api/v1/packages?${query}`) as Promise<PaginatedResult<DatasetCardItem> | null>
}

export async function getResource(nameOrId: string, resourceId: string) {
  const pkg = await getPackage(nameOrId)
  return pkg?.resources?.find((r) => r.id === resourceId) ?? null
}
