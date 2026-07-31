/**
 * Format a byte count as a human-readable string (e.g. "1.2 MB").
 * Returns null for null/undefined/negative values.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Render one cell of a tabular preview.
 *
 * Typed columns arrive as JS values rather than text now that the preview is
 * written from DuckDB's own types (ADR-046): `String()` on a Date gives
 * "Thu Apr 01 2023 09:00:00 GMT+0900 (…)" where the file said `2023-04-01`, and
 * a 64-bit integer arrives as a BigInt. Dates are shown in ISO form — what the
 * source CSV most often held, and unambiguous whatever the reader's locale.
 *
 * Shared by both readers of the preview Parquet: hyparquet renders the first
 * page, DuckDB-WASM the explorer (ADR-016). They read the same file, so a
 * column typed one way must not read two ways on screen.
 */
export function formatCell(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    // Midnight UTC is how a DATE (no time of day) comes back; showing 00:00:00
    // would invent a precision the column does not have.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
  }
  return String(value)
}
