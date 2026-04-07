/**
 * HTTP HEAD request for health check.
 * Lightweight liveness check + ETag/Last-Modified change detection.
 */

import { HEALTH_CHECK_TIMEOUT_MS } from '@/config'
import type { HeadCheckResult, ResourceForHealthCheck } from './types'

/**
 * Perform a HEAD request to the resource URL.
 * Never throws — always returns a structured result.
 */
export async function executeHeadCheck(res: ResourceForHealthCheck): Promise<HeadCheckResult> {
  try {
    const response = await fetch(res.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      redirect: 'follow',
    })

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
    }
  } catch (err) {
    return {
      httpStatus: null,
      healthStatus: 'error',
      etag: null,
      lastModified: null,
      changed: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}
