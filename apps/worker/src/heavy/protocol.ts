/**
 * What crosses between the worker and its heavy process (ADR-059). Apart from
 * the child so the parent can import it: loading the child's module loads
 * DuckDB and the document parsers.
 */

import type { InterpretedTableFile } from '../pipeline/interpret/table/write-table'
import type { ExtractedText } from '../pipeline/interpret/document/document-text'
import type { ReadPdf } from '../summary/material-files'

/** Files in, files and JSON out: the process holds no connection of any kind. */
export type HeavyRequest =
  | {
      kind: 'interpret-csv'
      csvPath: string
      parquetPath: string
      skipRows: number
      profilePath?: string
    }
  | { kind: 'interpret-json'; jsonPath: string; parquetPath: string; profilePath?: string }
  | { kind: 'extract-text'; documentPath: string; format: string; artifactPath: string }
  | { kind: 'read-pdf'; pdfPath: string; cutTo: number; cutPast: number; outPath: string }
  | { kind: 'downscale-image'; imagePath: string; outPath: string }

interface HeavyResults {
  'interpret-csv': InterpretedTableFile
  'interpret-json': InterpretedTableFile
  'extract-text': ExtractedText
  'read-pdf': ReadPdf
  /** False for an image whose header claims more pixels than the limit */
  'downscale-image': { written: boolean }
}

export type HeavyResult<R extends HeavyRequest> = HeavyResults[R['kind']]

/**
 * `tooLarge` says the failure was V8 refusing an allocation — a string or
 * buffer past its limits — which the parent takes as the request being too
 * large, as it does the heap running out, rather than recording V8's words.
 */
export type HeavyReply =
  { ok: true; result: unknown } | { ok: false; message: string; tooLarge?: boolean }

/**
 * Only the failures of size. An invalid array or typed array length is also
 * what a negative length read from a broken header gives, and that file is
 * damaged rather than large.
 */
const ALLOCATION_FAILURES = new Set(['Invalid string length', 'Array buffer allocation failed'])
const ALLOCATION_FAILURE_CODES = new Set(['ERR_STRING_TOO_LONG', 'ERR_BUFFER_TOO_LARGE'])

/** The reply for a request that threw `err` in the heavy process. */
export function failedReply(err: unknown): HeavyReply {
  const code = (err as { code?: unknown } | null)?.code
  const tooLarge =
    (err instanceof RangeError && ALLOCATION_FAILURES.has(err.message)) ||
    (typeof code === 'string' && ALLOCATION_FAILURE_CODES.has(code))
  return {
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    ...(tooLarge && { tooLarge }),
  }
}
