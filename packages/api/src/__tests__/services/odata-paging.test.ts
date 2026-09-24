import { describe, it, expect } from 'vitest'
import {
  estimateRowBytes,
  maxRowBytes,
  pageRowsWithin,
  rowsMayBeTooWide,
  rowsWithinByteBudget,
} from '../../services/odata/page-budget'
import {
  ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS,
  ODATA_ROW_GROUP_CAUTION_BYTES,
  ODATA_MAX_PAGE_BYTES,
  ODATA_MAX_PAGE_ROWS,
  ODATA_ROW_GROUP_BUDGET_BYTES,
} from '../../config'
import type { EdmModel } from '../../services/odata/edm'
import type { ResourceColumn } from '@kukan/shared'

const columns = (names: string[]): ResourceColumn[] =>
  names.map((name) => ({ name, type: 'string', nullable: false, nullCount: 0 }))

const model = (
  names: string[],
  rowCount: number,
  syntheticKey: string | null = null
): EdmModel => ({
  keyNames: syntheticKey ? [syntheticKey] : [names[0]],
  syntheticKey,
  keyFallback: null,
  columns: columns(names),
  rowCount,
})

describe('rowsWithinByteBudget', () => {
  it('pages a narrow table by rows, up to the row ceiling', () => {
    expect(rowsWithinByteBudget(80)).toBe(ODATA_MAX_PAGE_ROWS)
  })

  it('pages by bytes once a row costs more than the ceiling allows', () => {
    // The limit is what DuckDB prepares for, so it has to be what the 8 MB
    // budget will actually deliver — not what a count of cells guessed.
    expect(rowsWithinByteBudget(4000)).toBe(Math.floor(ODATA_MAX_PAGE_BYTES / 4000))
    expect(rowsWithinByteBudget(4000)).toBeLessThan(ODATA_MAX_PAGE_ROWS)
  })

  it('still moves on a table whose single row is past the whole budget', () => {
    expect(rowsWithinByteBudget(ODATA_MAX_PAGE_BYTES * 2)).toBe(1)
  })
})

describe('maxRowBytes', () => {
  it("follows the file's own groups, since a group is what must fit", () => {
    expect(maxRowBytes(4096)).toBe(Math.floor(ODATA_ROW_GROUP_BUDGET_BYTES / 4096))
    // The largest group an unrecorded file could hold has a lower ceiling
    expect(maxRowBytes(ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS)).toBeLessThan(maxRowBytes(4096))
    // And a file that recorded nothing has to fit two of those, since its pages
    // are not cut to boundaries and so may straddle
    expect(maxRowBytes(null)).toBe(Math.floor(maxRowBytes(ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS) / 2))
  })
})

describe('pageRowsWithin', () => {
  // A row group is what a Parquet read decodes to hand out one row of it, so a
  // page that crosses a boundary holds two of them.
  const GROUP = 4096

  it('leaves a narrow table alone, because its groups are small', () => {
    // 200 B a row: a group is 0.8 MB and the budget affords tens of them, so
    // the boundary never reaches the page.
    expect(pageRowsWithin(200, GROUP, 0)).toBe(rowsWithinByteBudget(200))
    expect(pageRowsWithin(200, GROUP, 3000)).toBe(rowsWithinByteBudget(200))
  })

  it('cuts a wide table at the end of the group it started in', () => {
    // 6 KB a row: one group is 24 MB, past the budget, so the page may touch
    // exactly one and stops where that one ends.
    expect(ODATA_ROW_GROUP_BUDGET_BYTES).toBeLessThan(GROUP * 6000)
    expect(pageRowsWithin(6000, GROUP, 3000)).toBe(GROUP - 3000)
    // Starting on a boundary, the byte budget is what binds again
    expect(pageRowsWithin(6000, GROUP, GROUP)).toBe(rowsWithinByteBudget(6000))
  })

  it('assumes the widest servable row where the size could not be worked out', () => {
    // Nothing to divide, so the page is sized as if the table sat at the edge of
    // what its groups can be read at — anything wider is refused anyway.
    expect(pageRowsWithin(null, GROUP, 0)).toBe(rowsWithinByteBudget(maxRowBytes(GROUP)))
    expect(pageRowsWithin(0, GROUP, 0)).toBe(pageRowsWithin(null, GROUP, 0))
  })

  it('cuts nothing where the file never recorded its groups', () => {
    // Two writers have made previews, at 5,000 rows a group and at 6,144, and
    // cutting on the wrong multiple is the straddle this exists to prevent. Such
    // a file is paged by bytes alone.
    expect(pageRowsWithin(6000, null, 3000)).toBe(rowsWithinByteBudget(6000))
    expect(pageRowsWithin(6000, null, 4095)).toBe(rowsWithinByteBudget(6000))
  })

  it('never returns nothing, however awkward the skip', () => {
    expect(pageRowsWithin(6000, GROUP, GROUP - 1)).toBe(1)
  })

  it('takes the row group as given, so a file of its own shape is honoured', () => {
    // At the same skip, a preview written with the legacy 6,144 rows is close
    // enough to its boundary to be cut there, while one written with 4,096 has
    // room for the whole byte budget.
    expect(pageRowsWithin(6000, 6144, 5000)).toBe(6144 - 5000)
    expect(pageRowsWithin(6000, 4096, 5000)).toBe(rowsWithinByteBudget(6000))
  })
})

describe('estimateRowBytes', () => {
  /** 100 B of values a row, in a charset that costs nothing on the way out. */
  const baseline = () => estimateRowBytes(100_000, 'UTF-8', model(['id'], 1000))!

  it('divides the content over the rows, and adds what each row repeats', () => {
    // 100 B of values a row, plus `"id":`/`"name":` on every one of them. No
    // cushion on top: what room there is to be wrong is measured, not added.
    const bytes = estimateRowBytes(100_000, 'UTF-8', model(['id', 'name'], 1000))
    expect(bytes).toBe(100 + ('id'.length + 6) + ('name'.length + 6))
  })

  it('counts the column the feed added, where it added one', () => {
    const keyed = estimateRowBytes(100_000, 'UTF-8', model(['id'], 1000, 'RowId'))!
    expect(keyed - baseline()).toBe('RowId'.length + 16)
  })

  it('allows for a Japanese file growing on its way to UTF-8', () => {
    const sjis = estimateRowBytes(100_000, 'Shift_JIS', model(['id'], 1000))!
    expect(sjis).toBeGreaterThan(baseline())
    // An unrecorded encoding is treated as one that grows: erring high costs a
    // round trip, erring low costs the page.
    expect(estimateRowBytes(100_000, null, model(['id'], 1000))).toBe(sjis)
  })

  it('asks what the file was decoded as, not what it was labelled', () => {
    // The labels a pipeline row can carry that all decode as UTF-8, and so cost
    // nothing on the way out — including the ones a failed detection leaves.
    for (const label of ['UTF8', 'ASCII', 'UNICODE', 'UNKNOWN', 'utf-8']) {
      expect(estimateRowBytes(100_000, label, model(['id'], 1000))).toBe(baseline())
    }
    for (const label of ['SJIS', 'EUCJP', 'euc-jp']) {
      expect(estimateRowBytes(100_000, label, model(['id'], 1000))).toBeGreaterThan(baseline())
    }
  })

  it('gives up rather than guess, where either half is missing', () => {
    expect(estimateRowBytes(null, 'UTF-8', model(['id'], 1000))).toBeNull()
    expect(estimateRowBytes(0, 'UTF-8', model(['id'], 1000))).toBeNull()
    // A table with no rows: nothing to page, and nothing to divide by
    expect(estimateRowBytes(100_000, 'UTF-8', model(['id'], 0))).toBeNull()
  })
})

describe('rowsMayBeTooWide', () => {
  const GROUP = 4096

  it('says nothing about a table whose groups sit inside the line', () => {
    expect(rowsMayBeTooWide(2000, GROUP)).toBe(false)
    expect(rowsMayBeTooWide(Math.floor(ODATA_ROW_GROUP_CAUTION_BYTES / GROUP), GROUP)).toBe(false)
  })

  it('cautions once a group would pass what a read is known to manage', () => {
    // The measured pair: 28 MB of group reads serve, 38 MB do not, and the line
    // sits just under the first. A table at 11.7 KB a row is well past it — and
    // it is the one the feed was measured refusing at read time.
    expect(rowsMayBeTooWide(11_735, GROUP)).toBe(true)
  })

  it('has nothing to say where the row size could not be estimated', () => {
    expect(rowsMayBeTooWide(null, GROUP)).toBe(false)
    expect(rowsMayBeTooWide(null, null)).toBe(false)
  })

  it('assumes the widest unrecorded groups, which two of them may straddle', () => {
    // An unrecorded file's pages are not cut to boundaries, so a page may hold
    // two groups — and the caution has to reckon with both.
    const perRow = Math.floor(
      ODATA_ROW_GROUP_CAUTION_BYTES / (2 * ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS)
    )
    expect(rowsMayBeTooWide(perRow, null)).toBe(false)
    expect(rowsMayBeTooWide(perRow * 2, null)).toBe(true)
  })
})
