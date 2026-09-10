import type { MatchedResource, MatchedResourcesCount } from '@kukan/search-adapter'

/** Rows drawn before the rest folds into "and N more". */
export const MATCHED_ROWS_SHOWN = 5

export interface MatchedRow {
  resource: MatchedResource
  /** Stands for every resource matched on this section name alone: `others` more. */
  folded: boolean
  others: number
}

/**
 * What the search card draws for a package's matched resources. A resource
 * that matched on its section alone matched as one of the section, not on
 * its own account — a heading over thirty files is one hit, not thirty — so
 * those fold by label into one row each with a count, while a resource matched
 * on its own name or description keeps its row (ADR-050). The adapter says
 * what each hit was on (`matchedOn`); one that does not fold nothing. Order
 * follows the first appearance.
 */
function matchedRows(matched: readonly MatchedResource[]): MatchedRow[] {
  const rows: MatchedRow[] = []
  const bySection = new Map<string, MatchedRow>()
  for (const resource of matched) {
    const { section, matchedOn } = resource
    const onSectionAlone =
      section &&
      matchedOn?.length === 1 &&
      matchedOn[0] === 'section' &&
      resource.matchSource !== 'content'
    if (!onSectionAlone) {
      rows.push({ resource, folded: false, others: 0 })
      continue
    }
    const row = bySection.get(section)
    if (row) {
      row.others++
    } else {
      const first = { resource, folded: true, others: 0 }
      bySection.set(section, first)
      rows.push(first)
    }
  }
  return rows
}

/**
 * The rows the card shows and how many resources it leaves out — the one cap,
 * so what is fetched for a row is fetched for a drawn one. A hidden folded row
 * hides all it stood for, and what the adapter counted but did not carry is
 * hidden too; when the adapter could only give a floor, so are these counts.
 */
export function foldMatched(
  matched: readonly MatchedResource[],
  count: MatchedResourcesCount = { total: matched.length, atLeast: false }
): { shown: MatchedRow[]; hidden: number; atLeast: boolean } {
  const rows = matchedRows(matched)
  const uncarried = Math.max(0, count.total - matched.length)
  const hiddenRows = rows.slice(MATCHED_ROWS_SHOWN)
  return {
    shown: rows.slice(0, MATCHED_ROWS_SHOWN),
    hidden: hiddenRows.reduce((n, row) => n + 1 + row.others, 0) + uncarried,
    atLeast: count.atLeast,
  }
}
