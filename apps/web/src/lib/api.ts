const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

/**
 * Server Components 用 fetch ラッパー
 * Cookie を転送して認証を維持する
 */
export async function serverFetch(path: string, init?: RequestInit) {
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get('better-auth.session_token')

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(sessionToken && { Cookie: `better-auth.session_token=${sessionToken.value}` }),
    },
  })
}

/**
 * Client Components 用 fetch ラッパー
 * credentials: 'include' で Cookie を自動送信
 */
export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
  })
}
