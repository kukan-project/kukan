import { clientFetch, problemDetail } from '@/lib/client-api'

/** What became of the update, and what to tell the user when it failed. */
export interface UpdateResourceResult {
  ok: boolean
  /**
   * The server's reason, when it gave one.
   *
   * A boolean was all this used to return, so the API's Problem Details went
   * nowhere and every failed edit read "could not update" — including the ones
   * where the API had named the field and the reason (kukan#296). The create
   * path already reads `detail`, which is why adding a resource explained
   * itself and editing the same resource did not.
   */
  detail?: string
}

/**
 * Update a resource with a partial patch. The resource PUT is a full-column
 * replace, so we fetch the current record first and merge the patch over it to
 * preserve non-editable fields (mimetype, size, hash, etc.).
 */
export async function updateResource(
  id: string,
  patch: Record<string, unknown>
): Promise<UpdateResourceResult> {
  const currentRes = await clientFetch(`/api/v1/resources/${id}`)
  if (!currentRes.ok) return { ok: false, detail: await problemDetail(currentRes) }
  const current = await currentRes.json()
  const res = await clientFetch(`/api/v1/resources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...current, ...patch }),
  })
  if (!res.ok) return { ok: false, detail: await problemDetail(res) }
  return { ok: true }
}
