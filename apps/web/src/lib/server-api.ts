import 'server-only'

import { cache } from 'react'

/**
 * Fetch wrapper for Server Components.
 * Calls Hono app.request() directly (no HTTP hop).
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

/**
 * Get the current user (deduped per request).
 * Only executes once within the same Server Component request.
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
