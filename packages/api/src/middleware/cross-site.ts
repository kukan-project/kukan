/**
 * Refuse a state-changing request a browser says came from another site.
 *
 * The session cookie is SameSite=Lax, which keeps it off a cross-site POST but
 * not off one from a sibling subdomain — the next site of a multi-site
 * deployment, or another app on the same registrable domain — and a POST with
 * no body needs no Content-Type a preflight would catch. The web app and the API
 * share one origin (ADR-012), so a browser that sends the cookie from anywhere
 * else is not the app. Only a request with the session cookie is judged, and
 * only where the browser says where it came from (`Sec-Fetch-Site`).
 */
import type { Context, Next } from 'hono'
import { ForbiddenError } from '@kukan/shared'
import { hasSessionCookie } from './auth'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `trustedOrigins`: the cross-origin callers TRUSTED_ORIGINS lets in with credentials. */
export function refuseCrossSite(trustedOrigins: string[] | undefined) {
  return async (c: Context, next: Next) => {
    const site = c.req.header('Sec-Fetch-Site')
    const fromElsewhere = site === 'same-site' || site === 'cross-site'
    if (!fromElsewhere || SAFE_METHODS.has(c.req.method) || !hasSessionCookie(c)) return next()
    if (trustedOrigins?.includes(c.req.header('Origin') ?? '')) return next()
    throw new ForbiddenError('Cross-site request refused')
  }
}
