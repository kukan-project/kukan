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
 * The Problem Details the API answered a failure with, when it gave them.
 *
 * Every error this API reports is RFC 9457; a body that is not JSON (an edge
 * page, a proxy) reads as undefined. Render it with `useProblemMessage`, which
 * translates the refusals it knows and falls back to the English `detail`.
 * The fallback wording for "no reason given" belongs to the caller, which knows
 * what the user was trying to do.
 */
export async function readProblem(res: Response): Promise<ProblemDetail | undefined> {
  const body: unknown = await res.json().catch(() => null)
  return body && typeof body === 'object' ? (body as ProblemDetail) : undefined
}
