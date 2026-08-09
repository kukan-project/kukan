/**
 * HTTP HEAD request for health check.
 * Lightweight liveness check + ETag/Last-Modified change detection.
 */

import { rootCauseMessage } from '@kukan/shared'
import { HopRefusedError, discardBody, safeFetch } from '@/safe-fetch'
import type { SafeFetchHooks } from '@/safe-fetch'
import { HEALTH_CHECK_TIMEOUT_MS } from '@/config'
import type { HeadCheckResult, ResourceForHealthCheck } from './types'

/**
 * Perform a HEAD request to the resource URL.
 *
 * Never throws — always returns a structured result, or null when a host the
 * chain redirected to would not have it inside the batch's budget. That is not
 * a fact about the resource, so it is not recorded against it.
 */
export async function executeHeadCheck(
  res: ResourceForHealthCheck,
  hooks?: SafeFetchHooks
): Promise<HeadCheckResult | null> {
  try {
    const response = await safeFetch(
      res.url,
      { method: 'HEAD', signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) },
      hooks
    )

    // A HEAD has no body to read and this never reads one anyway, so whatever
    // arrived goes back now. Servers do answer HEAD with a body, and one left
    // unread holds a connection on the Agent every fetch in the worker shares —
    // 200 URLs a tick makes that the expensive kind of mistake.
    await discardBody(response)

    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')

    if (!response.ok) {
      return {
        httpStatus: response.status,
        healthStatus: 'error',
        etag,
        lastModified,
        changed: false,
        errorMessage: `HTTP ${response.status} ${response.statusText}`,
        errorDetail: null,
      }
    }

    // Change detection: compare with stored values in extras
    const prevEtag = (res.extras.healthEtag as string) ?? null
    const prevLastModified = (res.extras.healthLastModified as string) ?? null

    let changed = false
    if (etag && prevEtag && etag !== prevEtag) {
      changed = true
    } else if (lastModified && prevLastModified && lastModified !== prevLastModified) {
      changed = true
    }

    return {
      httpStatus: response.status,
      healthStatus: 'ok',
      etag,
      lastModified,
      changed,
      errorMessage: null,
      errorDetail: null,
    }
  } catch (err) {
    // The chain reached a host whose turn was past the batch's budget. Nothing
    // is wrong with the resource — it simply was not asked.
    if (err instanceof HopRefusedError) return null
    const message = err instanceof Error ? err.message : String(err)
    // `fetch` says only `fetch failed` and leaves the reason underneath. It
    // goes to the log and not to the row: `extras` is rendered whole on the
    // public dataset page, and the reason names the address that was tried and
    // the hosts on the certificate that was rejected.
    const detail = rootCauseMessage(err)
    return {
      httpStatus: null,
      healthStatus: 'error',
      etag: null,
      lastModified: null,
      changed: false,
      errorMessage: message,
      errorDetail: detail === message ? null : detail,
    }
  }
}
