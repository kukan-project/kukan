/**
 * KUKAN Error Handler Middleware
 * Converts errors to RFC 7807 Problem Details format
 */

import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { KukanError, createLogger } from '@kukan/shared'

const fallbackLogger = createLogger({ name: 'api', level: 'error' })

/** The KukanError code each refusal status is named by. Hono raises some of
 *  these itself, without a code — named through here, a client cannot tell who
 *  refused the request. 500 is deliberately absent: a server error is reported
 *  by the fallback, which logs it and says nothing about its cause. */
const REFUSAL_CODES: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
}

const MAPPABLE_STATUSES = new Set([...Object.keys(REFUSAL_CODES).map(Number), 500])

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

/** Better Auth refuses through its own `APIError`, which is neither a
 *  `KukanError` nor an `HTTPException`. Unmapped, every refusal it raises —
 *  a weak password, an email already taken — reached the fallback and was
 *  reported as an unexpected 500. Its `body.code` is the same vocabulary the
 *  auth endpoints answer with, so it names the refusal directly. */
function isAuthApiError(
  err: unknown
): err is Error & { statusCode: number; body?: { code?: string; message?: string } } {
  return (
    err instanceof Error &&
    err.name === 'APIError' &&
    MAPPABLE_STATUSES.has((err as { statusCode?: number }).statusCode as number)
  )
}

export const errorHandler: ErrorHandler = (err, c) => {
  // Hono refuses some requests itself — a malformed JSON body is the common one
  // — with the right status but not the Problem Details shape. Unmapped, every
  // one of them reached the fallback below and was reported (and logged) as an
  // unexpected 500. Translated into the error every other refusal is reported
  // as, rather than rendered a second way here.
  let reported: unknown = err
  if (err instanceof HTTPException) {
    // A thrower that built its own response has already said what it wants
    if (err.res) return err.getResponse()
    const code = REFUSAL_CODES[err.status]
    // A status this cannot name stays unread, and falls through to the 500
    if (code) reported = new KukanError(err.message || code, code, err.status)
  } else if (isAuthApiError(err)) {
    const code = err.body?.code ?? REFUSAL_CODES[err.statusCode]
    if (code) reported = new KukanError(err.body?.message ?? err.message, code, err.statusCode)
  }

  if (reported instanceof KukanError || isKukanShaped(reported)) {
    return c.json(
      {
        type: 'about:blank',
        title: reported.code,
        status: reported.status,
        detail: reported.message,
        ...(reported.details && { details: reported.details }),
      },
      reported.status as 400 | 401 | 403 | 404 | 408 | 409 | 422 | 429 | 500 | 503
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
