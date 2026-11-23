/**
 * A workbook (XLSX, XLS) read as a table where it is a plain one (ADR-057,
 * Excel-tables spec §5–§6): the sheet is judged as its rows stream past, then
 * read again for the range alone, written as a UTF-8 CSV and handed to the CSV
 * interpretation with its structure given. Neither pass holds the sheet: the
 * judgment keeps counts and the rows at the table's edges, the CSV is written
 * a row at a time.
 */

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { hasSignature, MAX_PARQUET_SOURCE_SIZE, ZIP_SIGNATURE } from '@kukan/shared'
import type { NoTableReason } from '@kukan/shared'
import { MAX_TABLE_COLUMNS } from '@/config'
import { readHead } from '../../node-utils'
import { interpretCsv } from './csv'
import type { GridSheet, GridWorkbook } from './grid'
import { isAllocationFailure } from '../../../heavy/protocol'
import { judgePlainTable, type PlainTableReading } from './plain-table'
import type { SettledReading } from './settled-types'
import { xlsWorkbook } from './xls-grid'
import { xlsxWorkbook } from './xlsx-grid'
import type { InterpretedTableFile, ProfileRequest } from './write-table'

/** What interpreting a workbook gave: the table where it was a plain one, or why not. */
export interface InterpretedWorkbook extends InterpretedTableFile {
  /**
   * Every reason the workbook is not a plain table, in the order of spec §5.8;
   * `reason` is the first.
   */
  reasons?: NoTableReason[]
  /**
   * Why its grid could not be read, where it could not; nothing else is then
   * set. Answered rather than thrown: the workbook's text is read apart from
   * its grid, and a grid that does not read leaves the workbook a document,
   * as it was before tables were read from it.
   */
  unreadable?: string
}

const NO_TABLE = { rowCount: 0, columns: [] }

/**
 * Interpret the workbook at `workbookPath`, writing the CSV of its table to
 * `csvPath` on the way (removed after) and the Parquet to `parquetPath`.
 */
export async function interpretWorkbook(
  workbookPath: string,
  csvPath: string,
  parquetPath: string,
  profile?: ProfileRequest,
  reading?: SettledReading
): Promise<InterpretedWorkbook> {
  try {
    const written = await workbookCsv(workbookPath, csvPath)
    if ('answer' in written) return written.answer
    return await interpretCsv(csvPath, parquetPath, {
      structure: { given: { textColumns: written.textColumns } },
      profile,
      reading,
    })
  } finally {
    await rm(csvPath, { force: true })
  }
}

/**
 * Judge the workbook and write its table's CSV where it is a plain one. Its
 * own function, so nothing holds the decoded workbook once the CSV is
 * interpreted.
 */
async function workbookCsv(
  workbookPath: string,
  csvPath: string
): Promise<{ textColumns: string[] } | { answer: InterpretedWorkbook }> {
  const workbook = await openWorkbook(workbookPath)
  try {
    let judged
    try {
      judged = await judgePlainTable(workbook.sheets())
    } catch (err) {
      // Too large is the request's, and the parent records it as such
      if (isAllocationFailure(err)) throw err
      return {
        answer: { schema: NO_TABLE, unreadable: err instanceof Error ? err.message : String(err) },
      }
    }
    if ('reasons' in judged) {
      return { answer: { schema: NO_TABLE, reason: judged.reasons[0], reasons: judged.reasons } }
    }
    const { range } = judged.reading
    if (range.right - range.left + 1 > MAX_TABLE_COLUMNS) {
      return { answer: { schema: NO_TABLE, reason: 'too-many-columns' } }
    }
    const written = await writeRangeCsv(workbook.sheets(), judged.reading, csvPath)
    // Settled like a JSON object over its cap: the bytes decide it, so reading
    // it again ends the same way
    if ('tooLarge' in written) return { answer: { schema: NO_TABLE, reason: 'too-large' } }
    return written
  } finally {
    await workbook.close()
  }
}

/**
 * The reader for the workbook by what its bytes are, not what it was published
 * as: an XLSX is a ZIP package, anything else is read as XLS. An encrypted XLSX
 * is a compound file as XLS is, and the XLS reader is what tells it apart.
 */
async function openWorkbook(path: string): Promise<GridWorkbook> {
  const head = await readHead(path, ZIP_SIGNATURE.length)
  return hasSignature(head, ZIP_SIGNATURE) ? xlsxWorkbook(path) : xlsWorkbook(path)
}

/** Characters a CSV field is quoted for. */
const NEEDS_QUOTES = /[",\r\n]/

/** Bytes gathered before a write: one write a row costs more than the row. */
const CSV_CHUNK_CHARS = 64 * 1024

/**
 * Write the reading's range of its sheet as CSV (spec §6.1): the column names,
 * then every row of the range below the header, each value raw, hidden rows
 * and columns included. A cell holding only white space is empty, as the
 * judgment took it.
 *
 * Stopped past `maxBytes`, the largest CSV an interpretation reads: a workbook
 * is compressed, and its table can be twice its size or more as CSV, which
 * outgrows the heavy process where a CSV of the cap does not (spec §4.3).
 *
 * @returns the columns, by name, whose cells with a value are all strings
 *   (spec §6.3), or that the CSV would be over `maxBytes`.
 */
export async function writeRangeCsv(
  sheets: AsyncIterable<GridSheet>,
  reading: Pick<PlainTableReading, 'sheetNumber' | 'range' | 'columnNames'>,
  csvPath: string,
  maxBytes = MAX_PARQUET_SOURCE_SIZE
): Promise<{ textColumns: string[] } | { tooLarge: true }> {
  const { top, left, bottom, right } = reading.range
  const width = right - left + 1
  // Per column: a string seen, and anything else seen
  const strings = new Array<boolean>(width).fill(false)
  const others = new Array<boolean>(width).fill(false)
  let bytes = 0
  const counted = (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > maxBytes) throw new CsvTooLarge()
    return chunk
  }
  async function* lines() {
    let chunk = csvLine(reading.columnNames)
    for await (const sheet of sheets) {
      if (sheet.sheet !== reading.sheetNumber) continue
      for await (const row of sheet.rows) {
        if (row.row <= top) continue
        if (row.row > bottom) break
        const fields = new Array<string>(width).fill('')
        for (const cell of row.cells) {
          if (cell.col < left || cell.col > right || cell.value.trim() === '') continue
          fields[cell.col - left] = cell.value
          if (cell.kind === 'text') strings[cell.col - left] = true
          else others[cell.col - left] = true
        }
        chunk += csvLine(fields)
        if (chunk.length >= CSV_CHUNK_CHARS) {
          yield counted(chunk)
          chunk = ''
        }
      }
      break
    }
    if (chunk !== '') yield counted(chunk)
  }
  try {
    await pipeline(lines, createWriteStream(csvPath, { encoding: 'utf-8' }))
  } catch (err) {
    if (err instanceof CsvTooLarge) return { tooLarge: true }
    throw err
  }
  return {
    textColumns: reading.columnNames.filter((_, i) => strings[i] && !others[i]),
  }
}

class CsvTooLarge extends Error {}

function csvLine(fields: readonly string[]): string {
  return (
    fields.map((f) => (NEEDS_QUOTES.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',') + '\n'
  )
}
