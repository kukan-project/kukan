/**
 * KUKAN Pipeline — Extract Step
 * Detects encoding for all text-based formats, then generates Parquet for CSV/TSV.
 * Non-text formats return null (skip).
 */

import {
  streamToBuffer,
  streamToTempFile,
  cleanupTempFile,
  detectEncoding,
  bufferToUtf8,
} from '../node-utils'
import { getPreviewKey, isCsvFormat, isTextFormat, isZipFormat } from '@kukan/shared'
import { parquetWriteBuffer } from 'hyparquet-writer'
import Papa from 'papaparse'
import { extractZipManifest } from './extract-zip'
import type { PipelineContext } from '../types'

const ROW_GROUP_SIZE = 5_000
const MAX_COLUMNS = 500
const FOOTER_PREFIXES = ['合計', '注', '※', '出典', '備考', '計', 'total', 'note', 'source']
const FIXED_UTF8_FORMATS = new Set(['json', 'geojson', 'md'])

export interface ExtractResult {
  previewKey: string | null
  encoding: string
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
  // ZIP: stream to temp file, extract manifest, upload JSON
  if (isZipFormat(format)) {
    const zipStream = await ctx.storage.download(storageKey)
    const tmpPath = await streamToTempFile(zipStream)
    try {
      const manifest = await extractZipManifest(tmpPath)
      if (!manifest) return null
      const previewKey = getPreviewKey(packageId, resourceId, 'json')
      await ctx.storage.upload(previewKey, Buffer.from(JSON.stringify(manifest)), {
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

  // Remaining text formats (CSV/TSV/TXT/HTML): need full buffer for encoding detection
  const stream = await ctx.storage.download(storageKey)
  const fileBuffer = await streamToBuffer(stream)
  const encoding = detectEncoding(fmt, fileBuffer)

  // Non-CSV text: return encoding only (no Parquet preview)
  if (!isCsvFormat(format)) {
    return { previewKey: null, encoding }
  }

  // CSV/TSV: parse + generate Parquet (inline)
  const text = bufferToUtf8(fileBuffer, encoding)
  const result = Papa.parse(text, { header: false, skipEmptyLines: true })
  const allRows = result.data as string[][]
  const titleSkipped = skipTitleRows(allRows)

  if (titleSkipped.length === 0) {
    return { previewKey: null, encoding }
  }

  const headers = titleSkipped[0]

  // Reject extremely wide CSVs (e.g. pivot tables) — too many columns to preview
  if (headers.length > MAX_COLUMNS) {
    throw new Error(`Too many columns (${headers.length}), max ${MAX_COLUMNS}`)
  }

  const dataRows = removeFooterRows(titleSkipped.slice(1))

  const columnData = headers.map((header, colIndex) => ({
    name: header || `column_${colIndex}`,
    data: dataRows.map((row) => row[colIndex] ?? ''),
    type: 'STRING' as const,
  }))

  const parquetBuf = parquetWriteBuffer({ columnData, rowGroupSize: ROW_GROUP_SIZE })

  if (!parquetBuf) {
    return { previewKey: null, encoding }
  }

  // I/O: upload to Storage
  const previewKey = getPreviewKey(packageId, resourceId)
  await ctx.storage.upload(previewKey, Buffer.from(parquetBuf), {
    contentType: 'application/vnd.apache.parquet',
  })

  return { previewKey, encoding }
}

/**
 * Skip title rows at the top of the data.
 * A title row has only one non-empty cell AND the data has multiple columns.
 * Single-column CSVs are never title-skipped.
 */
function skipTitleRows(rows: string[][]): string[][] {
  if (rows.length === 0) return rows

  // Determine column count from the widest row
  const columnCount = Math.max(...rows.map((r) => r.length))
  if (columnCount <= 1) return rows

  let start = 0
  for (let i = 0; i < rows.length; i++) {
    const nonEmpty = rows[i].filter((cell) => cell.trim() !== '')
    if (nonEmpty.length <= 1) {
      start = i + 1
    } else {
      break
    }
  }
  return rows.slice(start)
}

/**
 * Remove footer rows from the bottom of the data.
 * Footer rows start with known prefixes (e.g. 合計, 注, ※).
 */
function removeFooterRows(rows: string[][]): string[][] {
  let end = rows.length
  for (let i = rows.length - 1; i >= 0; i--) {
    const firstCell = rows[i][0]?.trim().toLowerCase() ?? ''
    if (firstCell === '' || FOOTER_PREFIXES.some((p) => firstCell.startsWith(p))) {
      end = i
    } else {
      break
    }
  }
  return rows.slice(0, end)
}
