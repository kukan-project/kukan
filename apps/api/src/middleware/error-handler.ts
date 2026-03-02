/**
 * KUKAN Error Handler Middleware
 * Converts errors to RFC 7807 Problem Details format
 */

import type { ErrorHandler } from 'hono'
import { KukanError } from '@kukan/shared'

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
      err.status as any
    )
  }

  // Unknown error
  console.error('Unhandled error:', err)
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
