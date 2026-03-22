/**
 * Shared query string builder for paginated list pages.
 * Supports repeated params for array values (e.g. tags=env&tags=health).
 */
export function buildQuery(
  params: Record<string, string | string[] | number | undefined>,
  defaults?: { limit?: number }
) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v)
      continue
    }
    if (key === 'offset' && value === 0) continue
    if (key === 'limit' && value === (defaults?.limit ?? 20)) continue
    qs.set(key, String(value))
  }
  return qs.toString()
}

/**
 * Normalize a searchParams value (string | string[] | undefined) to string[].
 */
export function toArray(v?: string | string[]): string[] {
  if (!v) return []
  return Array.isArray(v) ? v : [v]
}
