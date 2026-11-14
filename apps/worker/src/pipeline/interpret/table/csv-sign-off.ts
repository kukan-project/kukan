/**
 * KUKAN Pipeline — telling a publisher's sign-off from a truncated row (ADR-046)
 *
 * A line the CSV reader refused is either a note the publisher signed the file
 * off with — a version line, a source, a title repeated at the bottom — or a row
 * of theirs that did not survive. The first is dropped and the table served; the
 * second refuses the table, because a table quietly short of a row publishes
 * counts that are wrong with nothing to show for it.
 *
 * **Nothing on the line settles which, so this is a guess.**
 *
 * Position cannot settle it: a truncated row at the end of a file sits exactly
 * where a sign-off sits, and it cannot even be established — DuckDB numbers a
 * refused line by CSV record, so a quoted cell holding newlines makes the number
 * smaller than the physical line (measured).
 *
 * Types cannot either, in either direction. The refused lines took no part in
 * deciding them, so a row with a broken value casts no better than prose does:
 * `20021001,N/A` and `2002/10/01,N/A` are rows, and both fail every cast the
 * table would ask of them.
 *
 * What is left is the shape — how many values the line holds against how many
 * the table has ({@link SIGN_OFF_MAX_CELLS}, {@link SIGN_OFF_MIN_MISSING}). Two
 * values in a table of thirty-one columns reads as a note rather than a row that
 * lost twenty-nine fields; two in a table of three is the ordinary way a row
 * breaks. **It is a guess and it can be wrong** — a row truncated to three of six
 * columns has a note's shape — so what it dropped is counted on the schema with
 * the lines, rather than kept quiet.
 *
 * **The counting is a parser's job.** The file that prompted this quotes every
 * cell, sign-off included, and splitting the raw text on the delimiter leaves the
 * quotes on the values and breaks any cell that holds one. Refusing every quoted
 * line instead — which is what this did first — refuses that file outright, which
 * is the file the whole change exists for.
 *
 * **The table can vouch for a line the shape cannot.** A list of prefectures in
 * which only some have a second URL has rows of three values in seven columns —
 * a note's shape — and the sparse ones at the bottom went as footers. A line is
 * a row when the table already has rows like it ({@link vouches}): the same
 * cells filled, each value the kind its column mostly holds.
 */

import Papa from 'papaparse'
import { BODY_SHAPE_SHARE, SIGN_OFF_MAX_CELLS, SIGN_OFF_MIN_MISSING } from '@/config'
import { CLUES } from './table-profile'

// How the file is punctuated, as the scan settled it — never guessed a second
// time here, or the line would be measured against a column count taken with
// another ruler. The shape itself lives in shared beside the schema field that
// persists it.
import { trimTrailing, type CsvDialect } from '@kukan/shared'

export type { CsvDialect }

/**
 * The kind of value a cell holds, coarse on purpose: enough to tell `出典: 港区`
 * from the numbers it sits under, not enough to tell two names apart. The
 * patterns are the profile's (RE2, whole value), read here by JavaScript for a
 * line and by DuckDB for the table; they read alike but for `\s`, which only
 * JavaScript stretches past ASCII.
 */
export const CELL_SHAPES = [
  ['url', CLUES.url.re],
  ['number', CLUES.number.re],
] as const
export type CellShape = (typeof CELL_SHAPES)[number][0] | 'text'

const SHAPE_TESTS = CELL_SHAPES.map(([shape, re]) => [shape, new RegExp(`^(?:${re})$`)] as const)

/** Each cell's shape by position, blank as null — all the rules need of a line. */
export type LineShape = (CellShape | null)[]

/** Characters a cell is trimmed of, in the line's cells and the table's alike. */
export const CELL_BLANKS = ' \t　'
const BLANK_ENDS = new RegExp(`^[${CELL_BLANKS}]+|[${CELL_BLANKS}]+$`, 'g')

/** A cell's value, trimmed; blank as null. */
export function cellValue(cell: string | null | undefined): string | null {
  const v = cell?.replace(BLANK_ENDS, '')
  return v ? v : null
}

/**
 * The shape of a line or a row that reads as a sign-off, padded to the table's
 * width; null when it does not read as one.
 *
 * @param cells - as parsed, or as the table holds them
 */
export function signOffShape(cells: (string | null)[], columnCount: number): LineShape | null {
  const values = cells.map(cellValue)
  if (!isSignOffShape(values.filter((v) => v !== null).length, columnCount)) return null
  return Array.from({ length: Math.max(columnCount, values.length) }, (_, i) => {
    const v = values[i] ?? null
    return v === null ? null : (SHAPE_TESTS.find(([, re]) => re.test(v))?.[0] ?? 'text')
  })
}

/**
 * The shape of a line the reader refused, when it reads as a sign-off; null
 * when it does not.
 *
 * @param text - the line as stored, terminators and all
 * @param columnCount - what the table ended up with
 */
export function refusedLineShape(
  text: string,
  dialect: CsvDialect,
  columnCount: number
): LineShape | null {
  const { delimiter, quote, escape } = dialect
  /** A character the text cannot hold, for a dialect the file does not use. */
  const NONE = '\u0000'
  // Terminators off both ends: what is stored carries the end of the record
  // before it, and any blank line between — the file this exists for arrives as
  // `"\n\r\n\"港区施設情報…\""`. Left on, the parser reads three rows and the line
  // is refused for not being one.
  const parsed = Papa.parse<string[]>(trimTrailing(text.replace(/^[\r\n]+/, ''), '\r\n'), {
    header: false,
    skipEmptyLines: false,
    delimiter,
    quoteChar: quote?.length === 1 ? quote : NONE,
    // The parser's default is the quote character, which is right for `""` and
    // wrong for every file DuckDB found a backslash in.
    escapeChar: escape?.length === 1 ? escape : NONE,
  })
  // Anything the parser is unsure of counts against the line. An unterminated
  // quote parses to something, and what it parses to says nothing about how many
  // values the publisher wrote; more than one row means the text held a newline,
  // which a single line does not.
  if (parsed.errors.length > 0 || parsed.data.length !== 1) return null
  return signOffShape(parsed.data[0], columnCount)
}

/**
 * The rule itself, over a count of values: a short line in a table far wider
 * than it.
 *
 * Trailing commas are punctuation, not content, so the count is of non-blank
 * cells: `出典: 港区,2026` and `出典: 港区,2026,,` are one note written twice, and
 * counting the blanks made the second four values — past what a sign-off holds.
 */
export function isSignOffShape(values: number, columnCount: number): boolean {
  return values <= SIGN_OFF_MAX_CELLS && columnCount - values >= SIGN_OFF_MIN_MISSING
}

/** The cells a line fills, as a string of `0`s and `1`s the table's rows are matched on. */
export const maskOf = (shape: LineShape) => shape.map((s) => (s === null ? '0' : '1')).join('')

/**
 * What the rows of the table above any footer say about the lines in question:
 * which of their masks the table has, and how the values of the columns they
 * fill are shaped.
 */
export interface TableBody {
  masks: Set<string>
  columns: Map<number, { values: number; shapes: Map<CellShape, number> }>
}

/**
 * Whether the table has rows like this line: one with the same cells filled,
 * and each value the kind most of its column holds.
 *
 * Both, because each alone keeps a note: a note in the first column of a table
 * of names is text under text, and a note the publisher also left mid-table has
 * a row with its cells filled. A line with nothing in it is never vouched for.
 *
 * What this cannot tell apart it leaves as a row: a note that looks like the
 * rows of its table in every way — under section headings that fill only the
 * first cell, say — is kept, and is a row of the table to anyone reading it too.
 */
export function vouches(body: TableBody, shape: LineShape): boolean {
  return (
    shape.some((s) => s !== null) &&
    body.masks.has(maskOf(shape)) &&
    shape.every((s, i) => {
      if (s === null) return true
      const column = body.columns.get(i)
      return !!column && (column.shapes.get(s) ?? 0) > BODY_SHAPE_SHARE * column.values
    })
  )
}
