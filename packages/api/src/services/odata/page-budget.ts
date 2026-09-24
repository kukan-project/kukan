/**
 * How big a page of a feed may be, and what a row of it costs.
 *
 * Pure arithmetic over the budgets in `config`, kept out of the service that
 * reads pages: nothing here opens a connection or touches a row, these numbers
 * are the most-churned text in this corner — every measurement rewrites a
 * paragraph — and the callers that need only them (the resource page, the
 * pipeline's own migration) should not drag a DuckDB session and the auth chain
 * in behind them.
 */

import { toCharset } from '@kukan/shared'
import {
  ODATA_MAX_PAGE_BYTES,
  ODATA_MAX_PAGE_ROWS,
  ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS,
  ODATA_ROW_GROUP_BUDGET_BYTES,
  ODATA_ROW_GROUP_CAUTION_BYTES,
} from '../../config'

/** What a Japanese legacy encoding costs on the way to UTF-8, at its worst:
 *  two bytes a character become three. */
const UTF8_EXPANSION = 1.5

/**
 * Rows the byte budget affords — the `LIMIT` that matches what a page will
 * actually deliver. At least one row, so a table whose single row is past the
 * whole budget still moves. {@link pageRowsWithin} is the entry point; this is
 * one of the two bounds it takes the smaller of.
 *
 * **The limit is a promise about how much will be read, and DuckDB prepares for
 * it.** Streaming keeps the rows from piling up in Node, but a limit of 50,000
 * rows on a page that stops at 8 MB still made it reserve for the whole limit:
 * measured at 70 MB RSS and a spill against 27 MB and none when the limit
 * matched what the budget delivers. The page served is identical either way.
 *
 * Derived from bytes rather than from a cell count, which is what this did
 * first. Cells stand in for size only while every cell is the same size, and on
 * a table of Japanese text columns they are out by the factor that puts the
 * read over its slot: 10 columns of 60 characters reserved for 27,272 rows and
 * failed inside {@link ODATA_MEMORY_LIMIT_BYTES}, where the 4,644 rows the budget
 * actually delivers read without trouble.
 *
 * **What a page actually costs, and so how wrong this may be.** A Parquet read
 * decodes a whole row group to hand out one row of it, so the peak is
 * `groups touched × group bytes + limit × row bytes`, of which a slot of
 * {@link ODATA_MEMORY_LIMIT_BYTES} takes about half in group reads before it
 * fails (DuckDB allocates in powers of two, so demand a little over asks for
 * twice and takes the budget at once). The limit's term is the one this function
 * bounds — to 8 MB, whatever the shape. The group's term belongs to the file,
 * which is why a page is also kept inside as few groups as the budget affords
 * (`pageRowsWithin`), and why a table too dense for even one group cannot be
 * served at all (ADR-055 §6).
 *
 * Measured against that: at 1.7 KB a row a limit of twice the true size still
 * reads and three times does not; at 3.5 KB even twice fails, the group's term
 * having taken most of the budget. Skew is the forgiving direction — a table of
 * 200 B rows with every twentieth at 20 KB read at a limit from a sixth of its
 * true average, because a chunk of 2,048 rows averages out.
 */
export function rowsWithinByteBudget(rowBytes: number): number {
  return Math.max(1, Math.min(ODATA_MAX_PAGE_ROWS, Math.floor(ODATA_MAX_PAGE_BYTES / rowBytes)))
}

/**
 * The widest row this file's groups can be read at — and so what an unmeasured
 * row is assumed to cost.
 *
 * A group is indivisible and has to fit {@link ODATA_ROW_GROUP_BUDGET_BYTES}, so
 * this is both the ceiling on what the feed can serve at all and the most
 * pessimistic assumption that is not already a refusal. A file written with
 * 4,096-row groups reaches ~3.9 KB a row; where the row size is unknown, a page
 * is sized as if the table sat at that edge.
 *
 * **A file that did not record its groups has to fit two of them**, because its
 * boundaries are unknown and its pages are therefore not cut to them
 * ({@link pageRowsWithin}) — so a page may straddle, and what must fit the
 * budget is two of the largest group any writer of previews has made. That lands
 * at ~1.3 KB a row: narrow tables are served exactly as before, and a wider one
 * is past what this can promise, which is the refusal ADR-055 §6 owes.
 */
export function maxRowBytes(rowGroupRows: number | null): number {
  return Math.max(1, Math.floor(ODATA_ROW_GROUP_BUDGET_BYTES / assumedGroupRows(rowGroupRows)))
}

/** The groups a page has to fit, where the file did not say how big one is. */
function assumedGroupRows(rowGroupRows: number | null): number {
  return rowGroupRows ?? 2 * ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS
}

/**
 * Whether this table's rows are wide enough that a page may fail to read.
 *
 * **Says "may", and means it.** The read is the only thing that knows, and it
 * answers with a refusal of its own when it cannot (`openPage`). This is the
 * estimate's proper use: a caution on the page that offers the URL, where being
 * wrong costs a sentence rather than a feed.
 *
 * Null where there is nothing to estimate from — no size, no rows — since a
 * caution nobody can act on is noise.
 */
export function rowsMayBeTooWide(rowBytes: number | null, rowGroupRows: number | null): boolean {
  if (rowBytes === null) return false
  return assumedGroupRows(rowGroupRows) * rowBytes > ODATA_ROW_GROUP_CAUTION_BYTES
}

/**
 * Rows a page may deliver from `skip`, bounded by the row groups it is allowed
 * to touch as well as by the byte budget.
 *
 * **The unit a page is read in is the row group, not the row.** Decoding one
 * hands out any row of it, so a page that crosses a boundary holds two groups
 * and a page inside one holds one — which is the difference between a read that
 * fits {@link ODATA_MEMORY_LIMIT_BYTES} and one that does not. Measured on a
 * 20-column table of Japanese text: every page that stayed inside a group read,
 * and every page that straddled one failed, at the first boundary and the
 * hundredth alike.
 *
 * So the page is allowed as many whole groups as
 * {@link ODATA_ROW_GROUP_BUDGET_BYTES} affords and then stops at that boundary.
 * On a narrow table the groups are small, the count is high, and the boundary
 * never binds — 11 groups at once measured fine, and pages stay at the row
 * ceiling. On a wide one a single group fills the budget, the count is 1, and
 * the page is cut to the end of the group it started in; the cost is one short
 * page per group, and the alternative is a page that cannot be read at all.
 *
 * **A table too wide for even one group cannot be served at all**, and nothing
 * here can rescue it: a group is indivisible, so every page of such a table
 * fails its read. That is answered where it happens — `refusalIfTooWide` turns
 * the read's own failure into a 501 — rather than predicted from here, because
 * the estimate was measured refusing tables that read
 * ({@link rowsMayBeTooWide}, which is all it is trusted with now).
 *
 * Letting one group too many in is what the budget cannot absorb, while one too
 * few costs a shorter page — so the budget it divides is set below what the read
 * survives ({@link ODATA_ROW_GROUP_BUDGET_BYTES}).
 */
export function pageRowsWithin(
  rowBytes: number | null,
  rowGroupRows: number | null,
  skip: number
): number {
  // The widest row one group can be read at, which is both the assumption where
  // the row size is unknown and — divided by this table's row — how many whole
  // groups the budget affords. Taken from the bound where the file's own figure
  // is missing, so the assumption stays the pessimistic one.
  const widest = maxRowBytes(rowGroupRows)
  const bytes = (rowBytes ?? 0) > 0 ? rowBytes! : widest
  const budgetRows = rowsWithinByteBudget(bytes)
  // **Cut only where the boundaries are known.** Two writers have made previews,
  // at 5,000 rows a group and at 6,144, and a file that recorded neither cannot
  // be cut at either: cutting on the wrong multiple manufactures the straddled
  // read this exists to prevent. Such a file is paged by bytes alone until a
  // re-interpretation records what it holds — and because it may then straddle,
  // the budget it was measured against above is the one for two groups.
  if (rowGroupRows === null) return budgetRows
  const groups = Math.max(1, Math.floor(widest / bytes))
  const toBoundary = groups * rowGroupRows - (skip % rowGroupRows)
  return Math.max(1, Math.min(budgetRows, toBoundary))
}

/**
 * Bytes one row of this table costs a page, or null where it cannot be told.
 *
 * Two parts, because the budget this feeds is counted in JSON: the values,
 * which the live content's size over its row count stands for, and the column
 * names, which OData repeats on every row and a wide table pays kilobytes for.
 *
 * **The values come from the source file, not from the preview.** A Parquet
 * footer reports what the column chunks encode, and the preview is dictionary
 * encoded: measured, a table that materializes at 4.5 KB a row reports 17 B
 * there — an estimate two orders of magnitude under what the page has to hold.
 *
 * One correction rides on the values: read in a Japanese legacy encoding the
 * file grows on its way to UTF-8, which is a unit conversion rather than a
 * cushion — the size is the file as stored, and a page serves it decoded. An
 * unrecorded encoding is treated as one that grows, since erring high costs a
 * round trip and erring low costs the page.
 *
 * **No cushion beyond that, deliberately.** Every other way this estimate is
 * wrong errs high already: CSV text is wider than the values it parses to for
 * numbers and dates, and quoting adds bytes the table never holds. What room is
 * left for the cases that err low is measured in {@link pageRowsWithin}.
 */
export function estimateRowBytes(
  size: number | null,
  encoding: string | null,
  model: { columns: readonly { name: string }[]; rowCount: number; syntheticKey?: string | null }
): number | null {
  if (size === null || size <= 0 || model.rowCount <= 0) return null
  // Whether the file grows is a question about the charset it was *decoded* as,
  // which `toCharset` is the one answer to — ASCII and the legacy labels a
  // detection failure leaves behind all decode as UTF-8 and cost nothing.
  const expansion = encoding !== null && toCharset(encoding) === 'utf-8' ? 1 : UTF8_EXPANSION
  // Per property: the quoted name, a colon, a comma, and quotes the value may
  // carry. The synthetic key adds its own name and an integer's digits.
  const names = model.columns.reduce((n, c) => n + Buffer.byteLength(c.name) + 6, 0)
  const key = model.syntheticKey ? Buffer.byteLength(model.syntheticKey) + 16 : 0
  return Math.ceil((size / model.rowCount) * expansion + names + key)
}
