/**
 * Fetch wrapper for Client Components.
 * Uses relative paths (same origin).
 */
import type { ProblemDetail } from '@kukan/shared'

export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    credentials: 'include',
  })
}

/**
 * The reason the API gave for a failure, when it gave one.
 *
 * Every error this API reports is RFC 7807, so `detail` names the field and
 * says what was wrong with it — the difference between "could not save" and
 * "url: Invalid URL". Reading it is open-coded at a dozen call sites, none of
 * which guard against a body that is not JSON (an edge page, a proxy) or a
 * `detail` that is present but empty, which a caller would then show as a blank
 * message. Here so that those converge on one answer as they are touched.
 *
 * Returns undefined rather than a message of its own: the fallback wording
 * belongs to the caller, which knows what the user was trying to do.
 */
export async function problemDetail(res: Response): Promise<string | undefined> {
  const body = await res.json().catch(() => null)
  const detail = (body as ProblemDetail | null)?.detail
  return detail ? detail : undefined
}
