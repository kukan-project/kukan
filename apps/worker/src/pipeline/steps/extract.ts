/**
 * KUKAN Pipeline — Extract Step
 * Detects encoding for all text-based formats, then generates Parquet for CSV/TSV.
 * Non-text formats return null (skip).
 */

import { randomUUID } from 'crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  streamToBuffer,
  streamToTempFile,
  cleanupTempFile,
  transcodeToUtf8,
  readHead,
} from '../node-utils'
import { detectEncoding } from '@kukan/shared/encoding-node'
import { getPreviewKey, isCsvFormat, isTextFormat, isZipFormat, toCharset } from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import { interpretCsv } from '../csv-interpret'
import { countTitleRows } from '../csv-title-rows'
import { extractZipManifest } from './extract-zip'
import type { PipelineContext } from '../types'
import { MAX_PARQUET_SOURCE_SIZE, MAX_CSV_COLUMNS, ENCODING_SAMPLE_SIZE } from '@/config'
const FIXED_UTF8_FORMATS = new Set(['json', 'geojson', 'md'])

export interface ExtractResult {
  previewKey: string | null
  encoding: string
  /** Column schema (CSV/TSV only, when a Parquet preview was generated). */
  schema?: ResourceSchema | null
}

/**
 * Detect encoding for text-based formats.
 * For CSV/TSV, also generates Parquet preview inline.
 * Returns encoding (always) and previewKey (CSV/TSV only), or null for non-text formats.
 */
export async function executeExtract(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string | null,
  ctx: PipelineContext
): Promise<ExtractResult | null> {
  // Unique to this run, so the object this run writes is never rewritten by a
  // later one. The pointer in resource_pipeline.preview_key is what readers
  // follow; the superseded object is deleted once that pointer moves.
  const runToken = randomUUID()

  // ZIP: stream to temp file, extract manifest, upload JSON
  if (isZipFormat(format)) {
    const zipStream = await ctx.storage.download(storageKey)
    const tmpPath = await streamToTempFile(zipStream)
    try {
      const manifest = await extractZipManifest(tmpPath)
      if (!manifest) return null
      const previewKey = getPreviewKey(packageId, resourceId, 'json', runToken)
      await ctx.putObject(previewKey, Buffer.from(JSON.stringify(manifest)), {
        contentType: 'application/json',
      })
      return { previewKey, encoding: 'UTF8' }
    } finally {
      await cleanupTempFile(tmpPath)
    }
  }

  if (!isTextFormat(format)) {
    return null
  }

  const fmt = format!.toLowerCase()

  // Formats with fixed encoding (JSON/GeoJSON/MD = UTF-8 by spec): skip download
  if (FIXED_UTF8_FORMATS.has(fmt)) {
    return { previewKey: null, encoding: 'UTF8' }
  }

  // XML: only need first 200 bytes for encoding declaration
  if (fmt === 'xml') {
    const xmlStream = await ctx.storage.download(storageKey)
    const headBuffer = await streamToBuffer(xmlStream, 200)
    const encoding = detectEncoding(fmt, headBuffer)
    return { previewKey: null, encoding }
  }

  // Non-CSV text (TXT/HTML): only need a sample for encoding detection
  if (!isCsvFormat(format)) {
    const sampleStream = await ctx.storage.download(storageKey)
    const sample = await streamToBuffer(sampleStream, ENCODING_SAMPLE_SIZE)
    const encoding = detectEncoding(fmt, sample)
    return { previewKey: null, encoding }
  }

  // CSV/TSV: DuckDB reads the file off local disk (ADR-046), so it is streamed
  // down rather than buffered — the JS heap never holds the whole table.
  const rawPath = await streamToTempFile(await ctx.storage.download(storageKey), 'csv')
  try {
    // A file this step interprets is detected over every byte, as it was when
    // the step buffered it. A 64KB sample is not enough: a CSV whose first
    // megabyte is ASCII — ids, dates, numbers — is read as UTF-8, and the
    // Japanese further down comes back as mojibake (measured, ADR-046). One it
    // only labels gets the sample the other text formats get: scanning 50MB to
    // annotate a file that will not be previewed costs seconds for nothing.
    const { size } = await stat(rawPath)
    const oversize = size > MAX_PARQUET_SOURCE_SIZE
    const encoding = detectEncoding(
      fmt,
      await readHead(rawPath, oversize ? ENCODING_SAMPLE_SIZE : size)
    )
    if (oversize) {
      return { previewKey: null, encoding }
    }

    const charset = toCharset(encoding)
    const csvPath = charset === 'utf-8' ? rawPath : await transcodeToUtf8(rawPath, charset)

    const { rows: titleRows, columnCount } = await countTitleRows(csvPath)
    if (columnCount === 0) {
      return { previewKey: null, encoding }
    }
    // Reject extremely wide CSVs (e.g. pivot tables) — too many columns to preview
    if (columnCount > MAX_CSV_COLUMNS) {
      throw new Error(`Too many columns (${columnCount}), max ${MAX_CSV_COLUMNS}`)
    }

    const parquetPath = `${csvPath}.parquet`
    const schema = await interpretCsv(csvPath, parquetPath, titleRows)

    const previewKey = getPreviewKey(packageId, resourceId, 'parquet', runToken)
    await ctx.putObject(previewKey, createReadStream(parquetPath), {
      contentType: 'application/vnd.apache.parquet',
    })

    return { previewKey, encoding, schema }
  } finally {
    // Every file above lives in the directory this made, so one removal covers
    // the download, the transcode and the Parquet.
    await cleanupTempFile(rawPath)
  }
}
