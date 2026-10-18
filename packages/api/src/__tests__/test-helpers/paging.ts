/**
 * Helpers for tests of offset paging over rows that tie on the sort key.
 *
 * Such a test writes the tied rows with ids that rank against the order the
 * database would leave ties in (insertion order for a sort, the reverse for a
 * backward index scan), so only an id tie-break yields the order it expects.
 */

/** A uuid that sorts by `n`. */
export function rankedId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** One field of every item across the pages of `path`, `limit` at a time, in page order. */
export async function pagedField(
  app: { request: (url: string) => Response | Promise<Response> },
  path: string,
  field: string,
  limit: number
): Promise<unknown[]> {
  const seen: unknown[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let offset = 0; ; offset += limit) {
    const res = await app.request(`${path}${sep}limit=${limit}&offset=${offset}`)
    const { items } = (await res.json()) as { items: Record<string, unknown>[] }
    seen.push(...items.map((item) => item[field]))
    if (items.length < limit) return seen
  }
}
