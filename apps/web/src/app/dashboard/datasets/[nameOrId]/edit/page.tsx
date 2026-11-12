import { redirect } from 'next/navigation'
import { datasetEditPath, editorStateQuery, resourceEditPath } from '@/lib/paths'
import { serverFetch } from '@/lib/server-api'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The dataset's id for a name. The new address must carry the id: a dataset
 * named `new` would otherwise land on the creation page, which owns that path,
 * before the editor could put its id in place. A name that cannot be read is
 * passed on as it is, for the editor to say it is not there.
 */
async function packageId(nameOrId: string, state: string | null): Promise<string> {
  if (UUID.test(nameOrId)) return nameOrId
  const target = encodeURIComponent(nameOrId)
  const query = editorStateQuery(state)
  try {
    let res = await serverFetch(`/api/v1/packages/${target}${query}`)
    // As the editor reads it: a draft opened without ?state=draft is not on the active path
    if (!res.ok && state !== 'deleted') {
      res = await serverFetch(`/api/v1/packages/${target}${query ? '' : '?state=draft'}`)
    }
    if (res.ok) return ((await res.json()) as { id: string }).id
  } catch {
    // Passed on as it is
  }
  return nameOrId
}

interface Props {
  params: Promise<{ nameOrId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The editor's previous address (ADR-072 decision 1). Bookmarks and links
 * written before the move land here and go on to the page that took its place;
 * `?resource=` now has a page of its own. `state` is carried, because the
 * package API answers `active` unless it is told to look at a draft or a
 * deleted dataset.
 */
export default async function LegacyEditRedirect({ params, searchParams }: Props) {
  const { nameOrId } = await params
  const { resource, state } = await searchParams
  const stateParam = typeof state === 'string' ? state : null
  const id = await packageId(nameOrId, stateParam)
  const base = typeof resource === 'string' ? resourceEditPath(id, resource) : datasetEditPath(id)
  redirect(`${base}${editorStateQuery(stateParam)}`)
}
