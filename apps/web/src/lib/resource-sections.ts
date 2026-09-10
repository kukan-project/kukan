import { opensBetween, sectionPath, MAX_SECTION_DEPTH } from '@kukan/shared'

/**
 * The web app's side of a resource list: how the dashboard rearranges one (a
 * section is a *run* of adjacent rows sharing a label, not a set) and how the
 * page indents one. What a heading is comes from `@kukan/shared`, shared with
 * the MCP tools (ADR-050).
 */

interface SectionRow {
  section?: string | null
}

type Label = string | null

export function opensSection(rows: readonly SectionRow[], index: number): boolean {
  return opensBetween(rows[index - 1]?.section, rows[index]?.section)
}

/** Where the run starting at `start` ends, exclusive. */
export function sectionRunEnd(rows: readonly SectionRow[], start: number): number {
  const label = rows[start]?.section ?? null
  let end = start
  while (end < rows.length && (rows[end].section ?? null) === label) end++
  return end
}

/** The section a dropped row lands in: the level of the row above it (ADR-050). */
export function sectionAfterDrop(rows: readonly SectionRow[], index: number): Label {
  return rows[index - 1]?.section ?? null
}

/** Where a row let go over `target` comes to rest. Onto a heading it takes the
 *  first member's place; from above, its own gap has already shifted that by one. */
function rowLanding(oldIndex: number, target: number, ontoHeading: boolean): number {
  return ontoHeading && oldIndex < target ? target - 1 : target
}

/**
 * A row dropped over `target`: where it lands and what it belongs to, decided
 * together (ADR-050). Onto a heading it becomes that section's first member —
 * the one thing the row above cannot say — otherwise it takes the row above's.
 */
export function dropRow<T extends SectionRow>(
  rows: readonly T[],
  oldIndex: number,
  target: number,
  ontoHeading: boolean,
  headingLabel: Label
): { rows: T[]; index: number } {
  const index = rowLanding(oldIndex, target, ontoHeading)
  const moved = [...rows]
  const [row] = moved.splice(oldIndex, 1)
  const section = ontoHeading ? headingLabel : sectionAfterDrop(moved, index)
  moved.splice(index, 0, { ...row, section })
  return { rows: moved, index }
}

/** Where a divider let go over `target` comes to rest: above a heading; above a
 *  row when moving up, below it when moving down. */
export function dividerLanding(from: number, target: number, ontoHeading: boolean): number {
  if (ontoHeading) return target
  return target < from ? target : target + 1
}

const HEADING_TAGS = ['h3', 'h4', 'h5'] as const

// Half a step per level: the indent has to read as depth without narrowing a
// deep card enough to make its resource look like a lesser one. Tailwind needs
// the classes spelled out; the depth cap keeps the table short.
const INDENT = ['', 'ml-2', 'ml-4', 'ml-6'] as const

export function indentClass(depth: number): string {
  return INDENT[Math.min(depth, MAX_SECTION_DEPTH)]
}

/** The element a heading at `depth` is: h3 under the list's h2, one level down per depth. */
export function headingTag(depth: number): (typeof HEADING_TAGS)[number] {
  return HEADING_TAGS[Math.min(Math.max(depth, 1), MAX_SECTION_DEPTH) - 1]
}

/** Row ids to their drawn index, built once so anchors resolve in O(1). */
export function rowIndexById(rows: readonly { id: string }[]): Map<string, number> {
  return new Map(rows.map((r, i) => [r.id, i]))
}

/** The slot a heading anchored above row `above` stands at: the row's index, or
 *  past the end when it stands at the end or the row is gone. */
export function anchorIndex(
  indexById: ReadonlyMap<string, number>,
  above: string | null,
  length: number
): number {
  return above === null ? length : (indexById.get(above) ?? length)
}

/**
 * Set a divider down at `to`: the rows from there to the next heading take
 * `label`, and `lift` — the run it headed until now, absent for an empty
 * heading — first goes to the section above it, as what stands above a divider
 * is the section above's (ADR-050). Set down `ontoHeading` it takes
 * nothing, so a section is split below its first row, never swallowed — the
 * caller says so, as the rows cannot show an empty heading.
 */
export function placeDivider<T extends SectionRow>(
  rows: readonly T[],
  label: string,
  to: number,
  { lift, ontoHeading = false }: { lift?: number; ontoHeading?: boolean } = {}
): { rows: T[]; at: number; claimed: number } {
  const at = Math.max(0, Math.min(rows.length, to))
  const section: Label[] = rows.map((r) => r.section ?? null)
  if (lift !== undefined)
    section.fill(sectionAfterDrop(rows, lift), lift, sectionRunEnd(rows, lift))

  let stop = at
  if (!ontoHeading)
    while (stop < section.length && !opensBetween(section[stop - 1], section[stop])) stop++
  for (let i = at; i < stop; i++) section[i] = label

  return {
    at,
    claimed: stop - at,
    rows: rows.map((r, i) =>
      (r.section ?? null) === section[i] ? r : { ...r, section: section[i] }
    ),
  }
}

// Sortable ids: a heading drags as its first member so the id holds still for
// the length of a drag; a heading with no members has an id of its own.
const PREFIX = 'section:'
const PENDING = `${PREFIX}pending:`

export function sectionDragId(firstMemberId: string): string {
  return `${PREFIX}${firstMemberId}`
}

export function pendingDragId(pendingId: string): string {
  return `${PENDING}${pendingId}`
}

export function isSectionDragId(dragId: string): boolean {
  return dragId.startsWith(PREFIX)
}

export function isPendingDragId(dragId: string): boolean {
  return dragId.startsWith(PENDING)
}

/** The row a heading's id points at. Check `isPendingDragId` first — a pending id names no row. */
export function rowIdOfDragId(dragId: string): string {
  return isSectionDragId(dragId) ? dragId.slice(PREFIX.length) : dragId
}

export function pendingIdOfDragId(dragId: string): string {
  return dragId.slice(PENDING.length)
}

/** A label drawn as a trail — `a/b/c` reads `a › b › c` — folded like every other view. */
export function sectionTrail(label: string, opts?: { html: boolean }): string {
  return sectionPath(label, opts).join(' › ')
}
