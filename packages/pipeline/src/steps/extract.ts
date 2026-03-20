/**
 * KUKAN Pipeline — Extract Step
 * Detects encoding for all text-based formats, then generates Parquet for CSV/TSV.
 * Non-text formats return null (skip).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Encoding from 'encoding-japanese'
import { streamToBuffer } from '../node-utils.js'
import { getPreviewKey, isCsvFormat, isTextFormat } from '@kukan/shared'
import { runWorker } from '../run-worker.js'
import type { PipelineContext } from '../types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, '..', 'workers', 'extract-worker.js')
const ROW_GROUP_SIZE = 5_000

export interface ExtractResult {
  previewKey: string | null
  encoding: string
}

/**
 * Detect encoding for text-based formats.
 * For CSV/TSV, also generates Parquet preview via worker thread.
 * Returns encoding (always) and previewKey (CSV/TSV only), or null for non-text formats.
 */
export async function extractStep(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string | null,
  ctx: PipelineContext
): Promise<ExtractResult | null> {
  if (!isTextFormat(format)) {
    return null
  }

  // I/O: download from Storage (main thread)
  const stream = await ctx.storage.download(storageKey)
  const fileBuffer = await streamToBuffer(stream)

  // Detect encoding (all text formats)
  const detected = Encoding.detect(fileBuffer)
  const encoding = typeof detected === 'string' ? detected : 'UTF8'

  // Non-CSV: return encoding only (no Parquet preview)
  if (!isCsvFormat(format)) {
    return { previewKey: null, encoding }
  }

  // CSV/TSV: parse + generate Parquet (worker thread)
  const { parquetBuffer } = await runWorker<
    { csvBuffer: Buffer; rowGroupSize: number },
    { parquetBuffer: Buffer | null; encoding: string }
  >(WORKER_PATH, { csvBuffer: fileBuffer, rowGroupSize: ROW_GROUP_SIZE })

  if (!parquetBuffer) {
    return { previewKey: null, encoding }
  }

  // I/O: upload to Storage (main thread)
  const previewKey = getPreviewKey(packageId, resourceId)
  await ctx.storage.upload(previewKey, Buffer.from(parquetBuffer), {
    contentType: 'application/vnd.apache.parquet',
  })

  return { previewKey, encoding }
}
