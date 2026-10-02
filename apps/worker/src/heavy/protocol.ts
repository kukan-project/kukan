/**
 * What crosses between the worker and its heavy process (ADR-059). Apart from
 * the child so the parent can import it: loading the child's module loads
 * DuckDB and the document parsers.
 */

import type { InterpretedCsv } from '../pipeline/interpret/csv'
import type { ExtractedText } from '../pipeline/steps/document-text'

/** Files in, files and JSON out: the process holds no connection of any kind. */
export type HeavyRequest =
  | { kind: 'interpret-csv'; csvPath: string; parquetPath: string; skipRows: number }
  | { kind: 'extract-text'; documentPath: string; format: string; textPath: string }

interface HeavyResults {
  'interpret-csv': InterpretedCsv
  'extract-text': ExtractedText
}

export type HeavyResult<R extends HeavyRequest> = HeavyResults[R['kind']]

export type HeavyReply = { ok: true; result: unknown } | { ok: false; message: string }
