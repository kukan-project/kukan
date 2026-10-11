/**
 * The shape of a block of the document text artifact, shared by the readers
 * of every format: how much text one holds, and the headings over it — a path
 * of titles, outermost first, that a heading of some level closes down to and
 * joins.
 */

/** Characters of a heading kept; a "heading" longer than this is a paragraph styled as one. */
export const HEADING_MAX_CHARS = 200

/** Characters of text a block holds at most; a longer run is written as several. */
export const BLOCK_MAX_CHARS = 32_000

/** The headings over what is read next, outermost first. */
export type HeadingPath = { level: number; title: string }[]

/** `text` as one heading: on one line, trimmed, cut to {@link HEADING_MAX_CHARS}. */
export function oneHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, HEADING_MAX_CHARS)
}

/** `path` with a heading of `level` read: it closes the headings at its level and below. */
export function pushHeading(path: HeadingPath, level: number, title: string): void {
  while (path.length > 0 && path[path.length - 1].level >= level) path.pop()
  if (title) path.push({ level, title })
}

/** `{ headings }` of `path`, as {@link headingsOf} leaves them out where there are none. */
export function headingsOver(path: HeadingPath): { headings?: string[] } {
  return headingsOf(path.map((h) => h.title))
}

/** `{ headings }` where there are any: a block with none leaves the key out. */
export function headingsOf(headings: string[] | undefined): { headings?: string[] } {
  return headings && headings.length > 0 ? { headings } : {}
}
