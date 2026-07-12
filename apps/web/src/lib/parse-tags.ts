/** Split a comma-separated tag input into trimmed, non-empty tag names.
 *  Accepts both the ASCII comma and the Japanese ideographic comma (、). */
export function parseTags(input: string): string[] {
  return input
    .split(/[,、]/)
    .map((name) => name.trim())
    .filter(Boolean)
}
