/**
 * KUKAN Pipeline — Interpret Step
 * Detects encoding for all text-based formats, then generates Parquet for CSV/TSV.
 * Non-text formats return null (skip).
 *
 * Reads the captured version rather than the live object (ADR-046). The version
 * file is immutable, which is what lets this be re-run: the same input always
 * gives the same interpretation, and a run that failed here leaves something a
 * later one can pick up unchanged.
 */

import { randomUUID } from 'crypto'
import { createReadStream } from 'node:fs'
import { streamToBuffer, streamToTempFile, cleanupTempFile } from '../node-utils'
import { detectEncoding } from '@kukan/shared/encoding-node'
import {
  getPreviewKey,
  isCsvFormat,
  isTextFormat,
  isZipFormat,
  MAX_PARQUET_SOURCE_SIZE,
} from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import { withInterpretedVersion } from '../interpret/version'
import { extractZipManifest } from '../interpret/zip'
import type { PipelineContext } from '../types'
import { ENCODING_SAMPLE_SIZE } from '@/config'
const FIXED_UTF8_FORMATS = new Set(['json', 'geojson', 'md'])

export interface InterpretResult {
  previewKey: string | null
  encoding: string
  /** Column schema (CSV/TSV only, when a Parquet preview was generated). */
  schema?: ResourceSchema | null
}

/** The captured version this step interprets. */
export interface InterpretSource {
  storageKey: string
  /**
   * Bytes the version holds, from its row. Known before the download, so a file
   * too large to interpret costs a sample rather than a full transfer.
   */
  size: number
}

export interface InterpretHooks {
  /**
   * The interpreted table, as a Parquet on local disk, for as long as this call
   * runs (ADR-046 §2). Layer 2 loads from here, so the catalog-wide lock covers
   * the load alone and not the interpretation that produced it.
   *
   * Called once the interpretation has returned, so its DuckDB instance is
   * closed before the ingest opens a session.
   *
   * Throwing fails the step. The caller records the ingest's own outcome inside
   * the hook, since layer 2 is advisory and rebuildable from layer 1.
   */
  onTable?(parquetPath: string): Promise<void>
}

/**
 * Detect encoding for text-based formats.
 * For CSV/TSV, also generates Parquet preview inline.
 * Returns encoding (always) and previewKey (CSV/TSV only), or null for non-text formats.
 */
export async function executeInterpret(
  resourceId: string,
  packageId: string,
  source: InterpretSource,
  format: string | null,
  ctx: PipelineContext,
  hooks: InterpretHooks = {}
): Promise<InterpretResult | null> {
  const { storageKey } = source
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

  // CSV/TSV too large to interpret: labelled from a sample like the other text
  // formats, and never transferred whole. The version row was measured at
  // capture and the file behind it is immutable, so this needs no download to
  // decide.
  if (source.size > MAX_PARQUET_SOURCE_SIZE) {
    const sampleStream = await ctx.storage.download(storageKey)
    const sample = await streamToBuffer(sampleStream, ENCODING_SAMPLE_SIZE)
    return { previewKey: null, encoding: detectEncoding(fmt, sample) }
  }

  // CSV/TSV: publish what the interpretation produced. The interpretation
  // itself is shared with the lake retry, which wants the table and nothing
  // else (ADR-046).
  const { encoding, schema, used } = await withInterpretedVersion(
    source,
    fmt,
    ctx,
    async (table) => {
      const previewKey = getPreviewKey(packageId, resourceId, 'parquet', runToken)
      await ctx.putObject(previewKey, createReadStream(table.parquetPath), {
        contentType: 'application/vnd.apache.parquet',
      })

      // Handed over after the upload, so the preview exists whatever the hook
      // does with it.
      await hooks.onTable?.(table.parquetPath)
      return { previewKey }
    }
  )

  // The schema goes back whether or not there was a table. An empty one is not
  // a missing answer: it records that this version has been interpreted and
  // holds nothing to load, which is what stops the hourly sweep handing it out
  // again for good (ADR-046).
  return { previewKey: null, encoding, schema, ...used }
}
