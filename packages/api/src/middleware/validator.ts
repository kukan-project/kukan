/**
 * KUKAN Request Validator
 * zValidator whose failures come back as RFC 7807 Problem Details
 */

import { zValidator as baseZValidator } from '@hono/zod-validator'
import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ValidationError } from '@kukan/shared'

/** "url: Invalid URL" — the field first, since that is what the caller must fix */
function describe(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

function raise(error: z.core.$ZodError): never {
  const { issues } = error
  throw new ValidationError(issues.map(describe).join(', '), {
    issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  })
}

/**
 * The upstream validator answers a failed parse with the raw ZodError and no
 * `detail`, so clients reading Problem Details saw nothing to show and fell
 * back to "the request failed" — hiding which field was wrong and why. Raising
 * ValidationError instead routes it through errorHandler like every other error
 * the API reports.
 *
 * A json body is also validated when it is absent: clients that set the JSON
 * content-type on every POST send a route whose body is optional an empty one,
 * and upstream reads that as a malformed body. Empty is not malformed — it is
 * the request that carries no options, and the schema decides whether that is
 * allowed. A body that is present but unparseable still fails.
 */
export const zValidator: typeof baseZValidator = ((target: never, schema: never) => {
  const validate = baseZValidator(target, schema, (result) => {
    if (result.success) return
    raise(result.error as z.core.$ZodError)
  })
  if (target !== 'json') return validate

  const handler: MiddlewareHandler = async (c, next) => {
    const contentType = c.req.header('Content-Type')
    if (contentType?.includes('json') && (await c.req.text()).trim() === '') {
      const result = (schema as z.ZodType).safeParse({})
      if (!result.success) raise(result.error as unknown as z.core.$ZodError)
      c.req.addValidatedData('json', result.data as never)
      return next()
    }
    return validate(c, next)
  }
  return handler
}) as typeof baseZValidator

/** A query parameter that may be repeated: string | string[] → string[] | undefined */
export const repeatedParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).filter(Boolean)))

/**
 * A list's `offset`. PostgreSQL takes OFFSET as a bigint and refuses a fraction,
 * so either would otherwise reach the query and answer 500 instead of 400.
 * As a number for MCP tools; {@link offsetParam} reads it from a query string.
 */
export const offsetNumber = z
  .number()
  .int()
  .min(0)
  .max(2 ** 31 - 1)

/** A list's `limit`, a whole number like {@link offsetNumber}. */
export const limitNumber = (max: number) => z.number().int().min(1).max(max)

export const offsetParam = z.coerce.number().pipe(offsetNumber)

export const limitParam = (max: number) => z.coerce.number().pipe(limitNumber(max))
