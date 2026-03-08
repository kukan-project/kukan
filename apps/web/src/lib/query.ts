/**
 * Shared query string builder for paginated list pages
 */
export function buildQuery(
  params: Record<string, string | number | undefined>,
  defaults?: { limit?: number }
) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    if (key === 'offset' && value === 0) continue
    if (key === 'limit' && value === (defaults?.limit ?? 20)) continue
    qs.set(key, String(value))
  }
  return qs.toString()
}
