/**
 * KUKAN Shared Utilities
 */

export const SESSION_COOKIE_NAME = 'better-auth.session_token'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Check if a string is a valid UUID v4 format.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Escape SQL LIKE/ILIKE wildcard characters (% and _) in user input.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

/** `text` cut to `max` characters and marked as cut, short of a surrogate pair it would split. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const high = text.charCodeAt(max - 1)
  return `${text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max)}…`
}
