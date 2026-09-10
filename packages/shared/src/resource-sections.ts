/**
 * How a resource list reads as sections (ADR-050): a section is a *run* of
 * adjacent rows sharing a label, and `/` in a label nests headings. The public
 * page, the dashboard, and the MCP tools draw from these same definitions.
 */

type Label = string | null

/** Whether a heading opens between two adjacent labels: the label changes to a non-null one. */
export function opensBetween(above: Label | undefined, own: Label | undefined): boolean {
  return !!own && own !== (above ?? null)
}

/** Levels a nested label is drawn as; deeper segments fold into the last label. */
export const MAX_SECTION_DEPTH = 3

/**
 * The label as the segments `/` reserves it into — none for the root; what lies
 * deeper than the cap folds into the last one. A label as search highlighted it
 * (`html`) splits the same way, sparing the one slash in `</mark>` — the only tag
 * the sanitized highlight can hold.
 */
export function sectionPath(section: Label | undefined, { html = false } = {}): string[] {
  if (!section) return []
  const parts = section.split(html ? /(?<!<)\// : '/')
  if (parts.length <= MAX_SECTION_DEPTH) return parts
  return [...parts.slice(0, MAX_SECTION_DEPTH - 1), parts.slice(MAX_SECTION_DEPTH - 1).join('/')]
}

/** The headings that open between two adjacent paths: every segment past the
 *  first that differs, outermost first — so a parent with no rows of its own is
 *  still named by its child's path. */
export function headingsBetween(
  above: readonly string[],
  path: readonly string[]
): { depth: number; label: string }[] {
  let shared = 0
  while (shared < path.length && shared < above.length && path[shared] === above[shared]) shared++
  return path.slice(shared).map((label, i) => ({ depth: shared + i + 1, label }))
}

/** Each row's place in the drawn list: the headings that open above it,
 *  outermost first, and the depth it sits at — the walk both the public page
 *  and the MCP text make. */
export function sectionLayout(
  rows: readonly { section?: string | null }[]
): { depth: number; headings: { depth: number; label: string }[] }[] {
  let above: string[] = []
  return rows.map((r) => {
    const path = sectionPath(r.section)
    const place = { depth: path.length, headings: headingsBetween(above, path) }
    above = path
    return place
  })
}
