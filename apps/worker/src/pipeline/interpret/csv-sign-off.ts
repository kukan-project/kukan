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
 */

import Papa from 'papaparse'
import { SIGN_OFF_MAX_CELLS, SIGN_OFF_MIN_MISSING } from '@/config'

/**
 * How the file is punctuated, as the scan settled it — never guessed a second
 * time here, or the line would be measured against a column count taken with
 * another ruler.
 *
 * All three are separate dialects and all three are recorded: a file can escape
 * its quotes by doubling them or with a backslash, and reading `\"` as the
 * parser's default would end the value there. Anything but a single character
 * means the file has none of that kind, which is how the sniffer reports an
 * absence.
 */
export interface CsvDialect {
  delimiter: string
  quote: string | null
  escape: string | null
}

/**
 * Whether a line the reader refused reads as a sign-off rather than a row.
 *
 * @param text - the line as stored, terminators and all
 * @param columnCount - what the table ended up with
 */
export function looksLikeSignOff(text: string, dialect: CsvDialect, columnCount: number): boolean {
  const { delimiter, quote, escape } = dialect
  /** A character the text cannot hold, for a dialect the file does not use. */
  const NONE = '\u0000'
  // Terminators off both ends: what is stored carries the end of the record
  // before it, and any blank line between — the file this exists for arrives as
  // `"\n\r\n\"港区施設情報…\""`. Left on, the parser reads three rows and the line
  // is refused for not being one.
  const parsed = Papa.parse<string[]>(text.replace(/^[\r\n]+|[\r\n]+$/g, ''), {
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
  if (parsed.errors.length > 0 || parsed.data.length !== 1) return false

  const cells = parsed.data[0].length
  return cells <= SIGN_OFF_MAX_CELLS && columnCount - cells >= SIGN_OFF_MIN_MISSING
}
