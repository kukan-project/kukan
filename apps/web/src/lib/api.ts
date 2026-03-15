/**
 * Server Components 用 fetch ラッパー
 * Hono app.request() を直接呼び出す（HTTP ホップなし）
 */
export async function serverFetch(path: string, init?: RequestInit) {
  const { cookies } = await import('next/headers')
  const { getApp } = await import('./hono-app')
  const { SESSION_COOKIE_NAME } = await import('@kukan/shared')

  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)

  const app = await getApp()
  // Dummy base URL for in-process Hono call (no actual HTTP request)
  const url = `http://localhost${path}`

  return app.request(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...(sessionToken && {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken.value}`,
      }),
    },
  })
}

import { cache } from 'react'

/**
 * 現在のユーザーを取得（リクエスト単位で dedup）
 * Server Components の同一リクエスト内で何度呼んでも1回だけ実行される
 */
export const getCurrentUser = cache(async () => {
  const res = await serverFetch('/api/v1/users/me')
  if (!res.ok) return null
  return res.json() as Promise<{
    id: string
    name: string
    email: string
    role?: string
    sysadmin: boolean
  }>
})

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
