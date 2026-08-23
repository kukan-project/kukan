import { z } from 'zod'

/**
 * The dialect a CSV was read under, as DuckDB sniffed it (`reject_scans`).
 *
 * Anything but a single character means the file has none of that kind — the
 * sniffer reports absence as sentinels like `(empty)`. One shape for the three
 * places that pass it around: the worker persists it on the schema, the API
 * serves it, and the gutter counts records under it.
 */
export const csvDialectSchema = z.object({
  delimiter: z.string(),
  quote: z.string().nullable(),
  escape: z.string().nullable(),
})
export type CsvDialect = z.infer<typeof csvDialectSchema>

/** The dialect to assume of a schema written before the sniffed one was kept. */
export const RFC4180_DIALECT: CsvDialect = { delimiter: ',', quote: '"', escape: '"' }

/**
 * What to number a schema's raw text under. Owns the meaning of an absent
 * `dialect`, so no view re-derives it:
 *
 * - Stored dialect: count under it.
 * - Dropped lines without one (schemas from before it was kept): RFC 4180,
 *   which is what those numbers were read as in practice.
 * - Neither: `null`, physical line numbers. There is no number to land on, and
 *   the dialect is genuinely unknown — DuckDB's `reject_scans` only exists
 *   when something was refused (measured), and re-sniffing every clean file
 *   costs as much as reading it (ADR-046).
 */
export function dialectOf(
  schema: { dialect?: CsvDialect; droppedLines?: number[] } | null | undefined
): CsvDialect | null {
  if (schema?.dialect) return schema.dialect
  return schema?.droppedLines?.length ? RFC4180_DIALECT : null
}

/** A sniffed character, or null where the sniffer reported an absence. */
function charOf(value: string | null | undefined): string | null {
  return value?.length === 1 ? value : null
}

/**
 * A gutter label per physical line: the record number where a record starts,
 * blank where a quoted newline continues one.
 *
 * This is the display half of `droppedLines` (`pipeline-types.ts`): the schema
 * carries record numbers as DuckDB counts them, and a text view that wants its
 * gutter to land on those numbers has to fold quoted newlines the same way —
 * under the file's own dialect, not RFC 4180's. Matches DuckDB's
 * `reject_errors.line` numbering (verified empirically): 1-based from the
 * physical start of the file, title rows and blank lines each counting as a
 * record, a record spanning quoted newlines counting once.
 *
 * A quote only opens a field at the *start* of one — at the start of a line or
 * after a delimiter. `5"6` holds a literal quote and continues nothing, and
 * walking it as an opening is how a stray inch mark used to blank every label
 * after itself. Inside a quoted field a doubled quote stays inside (unless the
 * file escapes with some other character, which then hides the character after
 * it instead); the closing quote returns to the unquoted walk until the next
 * delimiter.
 *
 * With no quote character — including no `dialect` at all — every line is its
 * own record, which is also the honest fallback: nothing can continue a record
 * then.
 */
export function csvRecordLabels(lines: string[], dialect?: CsvDialect | null): string[] {
  const quote = charOf(dialect?.quote)
  const escape = charOf(dialect?.escape)
  const delimiter = charOf(dialect?.delimiter)
  if (quote === null) return lines.map((_, i) => String(i + 1))

  let record = 0
  // Where the walk stands: at the start of a field, inside an unquoted one, or
  // inside a quoted one. Only the last survives a line break.
  let state: 'field-start' | 'unquoted' | 'quoted' = 'field-start'
  return lines.map((line) => {
    const label = state === 'quoted' ? '' : String(++record)
    if (state !== 'quoted') state = 'field-start'
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (state === 'quoted') {
        if (escape !== null && escape !== quote && ch === escape) {
          i++
        } else if (ch === quote) {
          if ((escape === null || escape === quote) && line[i + 1] === quote) i++
          else state = 'unquoted'
        }
      } else if (ch === delimiter) {
        state = 'field-start'
      } else if (state === 'field-start') {
        state = ch === quote ? 'quoted' : 'unquoted'
      }
    }
    return label
  })
}
