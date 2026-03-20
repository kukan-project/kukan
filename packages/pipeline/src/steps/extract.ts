/**
 * KUKAN Pipeline — Extract Step
 * Parses CSV/TSV from Storage via worker thread, generates Parquet, and stores it.
 * Non-supported formats return null (skip).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { streamToBuffer } from '@kukan/shared/node-utils'
import { getPreviewKey, isCsvFormat } from '@kukan/shared'
import { runWorker } from '../run-worker.js'
import type { PipelineContext } from '../types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, '..', 'workers', 'extract-worker.js')
const ROW_GROUP_SIZE = 5_000

export interface ExtractResult {
  previewKey: string
  encoding: string
}

/**
 * Extract structured data from Storage, convert to Parquet via worker thread, and store it.
 * Returns the preview key and detected encoding, or null for unsupported/empty formats.
 */
export async function extractStep(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string | null,
  ctx: PipelineContext
): Promise<ExtractResult | null> {
  if (!isCsvFormat(format)) {
    return null
  }

  // I/O: download from Storage (main thread)
  const stream = await ctx.storage.download(storageKey)
  const csvBuffer = await streamToBuffer(stream)

  // CPU: parse CSV + encode Parquet (worker thread — avoids blocking event loop)
  const { parquetBuffer, encoding } = await runWorker<
    { csvBuffer: Buffer; rowGroupSize: number },
    { parquetBuffer: Buffer | null; encoding: string }
  >(WORKER_PATH, { csvBuffer, rowGroupSize: ROW_GROUP_SIZE })

  if (!parquetBuffer) {
    return null
  }

  // I/O: upload to Storage (main thread)
  const previewKey = getPreviewKey(packageId, resourceId)
  await ctx.storage.upload(previewKey, Buffer.from(parquetBuffer), {
    contentType: 'application/vnd.apache.parquet',
  })

  return { previewKey, encoding }
}
