/**
 * KUKAN Shared Utilities
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Check if a string is a valid UUID v4 format.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
