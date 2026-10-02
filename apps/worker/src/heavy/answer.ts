/**
 * The heavy process's work, apart from the process so a test can run it in
 * its own (and reach the parsers its mocks replace).
 *
 * Each kind loads what it needs on its first request: a process that only
 * interprets CSVs never holds the document parsers, nor one that only reads
 * documents DuckDB.
 */

import type { HeavyRequest, HeavyResult } from './protocol'

export async function answer<R extends HeavyRequest>(request: R): Promise<HeavyResult<R>> {
  switch (request.kind) {
    case 'interpret-csv': {
      const { interpretCsv } = await import('../pipeline/interpret/csv')
      return (await interpretCsv(
        request.csvPath,
        request.parquetPath,
        request.skipRows
      )) as HeavyResult<R>
    }
    case 'extract-text': {
      const { extractDocumentText } = await import('../pipeline/steps/document-text')
      return (await extractDocumentText(
        request.documentPath,
        request.format,
        request.textPath
      )) as HeavyResult<R>
    }
  }
}
