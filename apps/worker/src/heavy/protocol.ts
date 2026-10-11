/**
 * What crosses between the worker and its heavy process (ADR-059). Apart from
 * the child so the parent can import it: loading the child's module loads
 * DuckDB and the document parsers.
 */

import type { InterpretedTableFile } from '../pipeline/interpret/table/write-table'
import type { ExtractedText } from '../pipeline/interpret/document/document-text'

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

interface HeavyResults {
  'interpret-csv': InterpretedTableFile
  'interpret-json': InterpretedTableFile
  'extract-text': ExtractedText
}

export type HeavyResult<R extends HeavyRequest> = HeavyResults[R['kind']]

export type HeavyReply = { ok: true; result: unknown } | { ok: false; message: string }
