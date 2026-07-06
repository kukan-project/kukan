/**
 * KUKAN Error Handler Middleware
 * Converts errors to RFC 7807 Problem Details format
 */

import type { ErrorHandler } from 'hono'
import { KukanError, createLogger } from '@kukan/shared'

const fallbackLogger = createLogger({ name: 'api', level: 'error' })

const MAPPABLE_STATUSES = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 503])

/** A KukanError thrown by another copy of @kukan/shared (e.g. across dev-server
 *  module generations) fails instanceof — recognize it by shape instead.
 *  The name check keeps third-party errors out of this branch (a foreign error
 *  mapped here skips logging and exposes its message to the client); it relies
 *  on the KukanError base constructor setting this.name = 'KukanError', which
 *  subclasses must not override. */
function isKukanShaped(err: unknown): err is KukanError {
  return (
    err instanceof Error &&
    err.name === 'KukanError' &&
    typeof (err as Partial<KukanError>).code === 'string' &&
    MAPPABLE_STATUSES.has((err as Partial<KukanError>).status as number)
  )
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof KukanError || isKukanShaped(err)) {
    return c.json(
      {
        type: 'about:blank',
        title: err.code,
        status: err.status,
        detail: err.message,
        ...(err.details && { details: err.details }),
      },
      err.status as 400 | 401 | 403 | 404 | 408 | 409 | 422 | 429 | 500 | 503
    )
  }

  // Unknown error — fallback logger guards against errors before context middleware
  const log = c.get('logger') ?? fallbackLogger
  log.error({ err }, 'Unhandled error')
  return c.json(
    {
      type: 'about:blank',
      title: 'INTERNAL_SERVER_ERROR',
      status: 500,
      detail: 'An unexpected error occurred',
    },
    500
  )
}
