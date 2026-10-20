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
      const { interpretCsv } = await import('../pipeline/interpret/table/csv')
      return (await interpretCsv(
        request.csvPath,
        request.parquetPath,
        request.skipRows,
        request.profilePath
      )) as HeavyResult<R>
    }
    case 'interpret-json': {
      const { interpretJson } = await import('../pipeline/interpret/table/json')
      return (await interpretJson(
        request.jsonPath,
        request.parquetPath,
        request.profilePath
      )) as HeavyResult<R>
    }
    case 'extract-text': {
      const { extractDocumentText } = await import('../pipeline/interpret/document/document-text')
      return (await extractDocumentText(
        request.documentPath,
        request.format,
        request.artifactPath
      )) as HeavyResult<R>
    }
    case 'read-pdf': {
      const { readPdf } = await import('../summary/material-files')
      return (await readPdf(
        request.pdfPath,
        request.cutTo,
        request.cutPast,
        request.outPath
      )) as HeavyResult<R>
    }
    case 'downscale-image': {
      const { downscaleImage } = await import('../summary/material-files')
      return (await downscaleImage(request.imagePath, request.outPath)) as HeavyResult<R>
    }
  }
}
