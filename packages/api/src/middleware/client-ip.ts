/**
 * The address a request came from, read the way the sign-in rate limits read
 * it: from the header `CLIENT_IP_HEADER` names (`@kukan/shared`'s client-ip.ts
 * says which and why), first value. Not a middleware — the routes that count
 * requests per caller ask for it; the rest never need it.
 */
import type { Context } from 'hono'
import { isIP } from 'node:net'
import type { Caller } from '../services/concurrency/caller-limit'

/**
 * The client's IP, or `undefined` when the header is absent or holds no
 * address — a direct connection in local development, mostly. The callers that
 * key on it skip their cap for such a request rather than share one bucket
 * between every request without an address.
 */
export function clientIp(c: Context): string | undefined {
  const first = c.req.header(c.get('env').CLIENT_IP_HEADER)?.split(',')[0]?.trim()
  return first && isIP(first) !== 0 ? first : undefined
}

/** Who is asking, for the per-caller limits: the signed-in user if any, and the address. */
export function callerOf(c: Context): Caller {
  return { userId: c.get('user')?.id, ip: clientIp(c) }
}
