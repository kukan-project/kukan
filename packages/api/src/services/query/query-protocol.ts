/**
 * What crosses between a resource query's process and the web server
 * (`query-process.ts` / `query-child.ts`). Apart from the child so the parent
 * can import it: loading the child's module is what raises its OOM score.
 */

import { RequestTimeoutError, ServiceUnavailableError, ValidationError } from '@kukan/shared'
import type { SandboxLimits, SandboxResult } from './duckdb-sandbox'

export interface QueryRequest {
  location: string
  sql: string
  limits: SandboxLimits
}

/** The error classes the parent rebuilds; anything else arrives as `internal` (500). */
export const FAILURE_CLASSES = {
  validation: ValidationError,
  timeout: RequestTimeoutError,
  unavailable: ServiceUnavailableError,
} as const

export type QueryFailureKind = keyof typeof FAILURE_CLASSES | 'internal'

export type QueryReply =
  { ok: true; result: SandboxResult } | { ok: false; kind: QueryFailureKind; message: string }
