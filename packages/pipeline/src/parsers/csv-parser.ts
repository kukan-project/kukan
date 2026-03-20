/**
 * KUKAN Smart CSV Parser
 * Parses CSV/TSV with title-row skipping, footer removal, and encoding detection
 */

import Papa from 'papaparse'
import Encoding from 'encoding-japanese'
import type { ExtractedData } from '../types'

const FOOTER_PREFIXES = ['合計', '注', '※', '出典', '備考', '計', 'total', 'note', 'source']

/**
 * Check if a format/mimetype indicates CSV or TSV
 */
export function isCsvFormat(format?: string | null, mimetype?: string | null): boolean {
  const f = format?.toLowerCase()
  const m = mimetype?.toLowerCase()
  return (
    f === 'csv' ||
    f === 'tsv' ||
    m === 'text/csv' ||
    m === 'application/csv' ||
    m === 'text/tab-separated-values'
  )
}

/**
 * Parse a CSV/TSV buffer with smart title-row skipping and footer removal.
 */
export function parseBuffer(buf: Buffer): ExtractedData {
  const detected = Encoding.detect(buf)
  const encoding = typeof detected === 'string' ? detected : 'UTF8'
  const text = bufferToUtf8(buf, encoding)

  const result = Papa.parse(text, { header: false, skipEmptyLines: true })
  const allRows = result.data as string[][]

  if (allRows.length === 0) {
    return { headers: [], rows: [], encoding }
  }

  // Smart: skip title rows at top, remove footer rows at bottom
  const titleSkipped = skipTitleRows(allRows)

  if (titleSkipped.length === 0) {
    return { headers: [], rows: [], encoding }
  }

  const headers = titleSkipped[0]
  const dataRows = removeFooterRows(titleSkipped.slice(1))

  return {
    headers,
    rows: dataRows,
    encoding,
  }
}

/**
 * Skip title rows at the top of the data.
 * A title row has only one non-empty cell.
 */
function skipTitleRows(rows: string[][]): string[][] {
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

/** Convert buffer to UTF-8 string using detected encoding */
function bufferToUtf8(buf: Buffer, encoding: string): string {
  if (encoding !== 'UTF8' && encoding !== 'ASCII') {
    const converted = Encoding.convert(buf, { to: 'UNICODE', from: encoding as Encoding.Encoding })
    return Encoding.codeToString(converted)
  }
  return buf.toString('utf-8')
}
