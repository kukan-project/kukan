/**
 * Fetch wrapper for Client Components.
 * Uses relative paths (same origin).
 */
export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    credentials: 'include',
  })
}
