/**
 * Client Components 用 fetch ラッパー
 * 同一オリジンなので相対パスで fetch
 */
export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    credentials: 'include',
  })
}
