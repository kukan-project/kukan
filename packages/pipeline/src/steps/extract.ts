/**
 * KUKAN Pipeline — Extract Step
 * Parses CSV/TSV, generates Parquet preview, and stores it in Storage.
 * Non-supported formats return null (skip).
 */

import { readFile } from 'fs/promises'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { isCsvFormat, parseBuffer } from '../parsers/csv-parser'
import type { PipelineContext } from '../types'

const ROW_GROUP_SIZE = 5_000

/**
 * Extract structured data from a file, convert to Parquet, and store it.
 * Returns the storage key for the Parquet file, or null for unsupported formats.
 */
export async function extractStep(
  resourceId: string,
  packageId: string,
  tmpFile: string,
  format: string | null,
  ctx: PipelineContext
): Promise<string | null> {
  if (!isCsvFormat(format)) {
    return null
  }

  const buf = await readFile(tmpFile)
  const extracted = parseBuffer(buf)

  if (extracted.headers.length === 0) {
    return null
  }

  // Transpose rows to columnar data for Parquet
  const columnData = extracted.headers.map((header, colIndex) => ({
    name: header || `column_${colIndex}`,
    data: extracted.rows.map((row) => row[colIndex] ?? ''),
    type: 'STRING' as const,
  }))

  const parquetBuf = parquetWriteBuffer({
    columnData,
    rowGroupSize: ROW_GROUP_SIZE,
    codec: 'UNCOMPRESSED',
  })

  const previewKey = `previews/${packageId}/${resourceId}.parquet`
  await ctx.storage.upload(previewKey, Buffer.from(parquetBuf), {
    contentType: 'application/vnd.apache.parquet',
  })

  return previewKey
}
