/**
 * KUKAN Pipeline — title-row detection for CSV/TSV (ADR-046)
 *
 * Japanese spreadsheets routinely put a title above the header — a single cell
 * on its own line, sometimes several. DuckDB finds the header row but has no
 * notion of what sits above it, so the count of lines to skip is worked out here
 * and handed to `read_csv` as `skip`.
 *
 * Only the head of the file is read: a title is by definition at the top, and
 * the header row ends the run.
 */

import Papa from 'papaparse'
import { CSV_TITLE_SCAN_BYTES } from '@/config'
import { readHead } from './node-utils'

export interface TitleRowScan {
  /**
   * Physical lines to skip before the header row — what `read_csv`'s `skip`
   * counts. Not the same as the number of title rows: a blank line between the
   * title and the header is a line DuckDB has to be told about, while the CSV
   * parser folds it away.
   */
  rows: number
  /** Columns in the header, or 0 when the file has no rows to describe. */
  columnCount: number
}

/** Cells in a row that are not blank once trimmed. */
function nonEmptyCount(row: string[]): number {
  return row.reduce((n, cell) => (cell.trim() !== '' ? n + 1 : n), 0)
}

/**
 * Count the title rows at the top of a UTF-8 CSV.
 *
 * A title row carries at most one non-empty cell, and only counts as one when
 * the data has several columns — in a single-column file every row would
 * qualify, and the whole file would be skipped.
 */
export async function countTitleRows(csvPath: string): Promise<TitleRowScan> {
  const head = (await readHead(csvPath, CSV_TITLE_SCAN_BYTES)).toString('utf-8')
  // Blank lines are kept: one sitting between the title and the header is a
  // line `skip` has to account for, and it satisfies the title rule anyway.
  const parsed = Papa.parse<string[]>(head, { header: false, skipEmptyLines: false })
  // The last row of a truncated read is usually a partial line; dropping it
  // costs nothing, since a title run that reaches 64KB is not a title run.
  const rows = parsed.data.slice(0, Math.max(0, parsed.data.length - 1))
  if (rows.length === 0) return { rows: 0, columnCount: 0 }

  const columnCount = Math.max(...rows.map((r) => r.length))
  if (columnCount <= 1) return { rows: 0, columnCount }

  let skip = 0
  for (const row of rows) {
    if (nonEmptyCount(row) > 1) break
    skip++
  }
  // Every row scanned looked like a title: treat none of them as one rather
  // than skip a header this never saw.
  if (skip === rows.length) return { rows: 0, columnCount }

  return { rows: skip === 0 ? 0 : physicalLines(head, skip), columnCount: rows[skip].length }
}

/**
 * Lines the first `rowCount` CSV rows occupy. A quoted field may hold newlines,
 * so counting rows is not counting lines — and `skip` counts lines. Papa reports
 * where it stopped, which makes this exact rather than an assumption about what
 * a title row may contain.
 */
function physicalLines(text: string, rowCount: number): number {
  const { meta } = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    preview: rowCount,
  })
  const consumed = text.slice(0, meta.cursor)
  return (consumed.match(/\n/g) ?? []).length
}
