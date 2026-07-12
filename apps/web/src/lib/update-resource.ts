import { clientFetch } from '@/lib/client-api'

/**
 * Update a resource with a partial patch. The resource PUT is a full-column
 * replace, so we fetch the current record first and merge the patch over it to
 * preserve non-editable fields (mimetype, size, hash, etc.). Returns whether
 * the update succeeded.
 */
export async function updateResource(id: string, patch: Record<string, unknown>): Promise<boolean> {
  const currentRes = await clientFetch(`/api/v1/resources/${id}`)
  if (!currentRes.ok) return false
  const current = await currentRes.json()
  const res = await clientFetch(`/api/v1/resources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...current, ...patch }),
  })
  return res.ok
}
