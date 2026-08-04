/**
 * KUKAN Request Validator
 * zValidator whose failures come back as RFC 7807 Problem Details
 */

import { zValidator as baseZValidator } from '@hono/zod-validator'
import type { z } from 'zod'
import { ValidationError } from '@kukan/shared'

/** "url: Invalid URL" — the field first, since that is what the caller must fix */
function describe(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * The upstream validator answers a failed parse with the raw ZodError and no
 * `detail`, so clients reading Problem Details saw nothing to show and fell
 * back to "the request failed" — hiding which field was wrong and why
 * (kukan#285). Raising ValidationError instead routes it through errorHandler
 * like every other error the API reports.
 */
export const zValidator: typeof baseZValidator = ((target: never, schema: never) =>
  baseZValidator(target, schema, (result) => {
    if (result.success) return
    const issues = (result.error as z.core.$ZodError).issues
    throw new ValidationError(issues.map(describe).join(', '), {
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
    })
  })) as typeof baseZValidator
