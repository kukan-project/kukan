/**
 * KUKAN Error Handler Middleware
 * Converts errors to RFC 7807 Problem Details format
 */

import type { ErrorHandler } from 'hono'
import { KukanError, createLogger } from '@kukan/shared'

const fallbackLogger = createLogger({ name: 'api', level: 'error' })

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof KukanError) {
    return c.json(
      {
        type: 'about:blank',
        title: err.code,
        status: err.status,
        detail: err.message,
        ...(err.details && { details: err.details }),
      },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500
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
