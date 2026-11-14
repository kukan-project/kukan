/**
 * KUKAN column vocabulary — a pack's version from what it says
 */

import type { SchemeDefinition } from './types'

/** FNV-1a, 32 bits: no dependency, and a version needs only to change, not to resist forging. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * A pack's version: its code tables' own, and a fingerprint of everything else
 * its schemes say — the foldings, the representations, the values that are no
 * area. Changing any of them changes how columns are read, so it changes the
 * version, and the registry state with it (ADR-073 §決定 4).
 */
export function packVersion(tablesVersion: string, schemes: SchemeDefinition[]): string {
  const definitions = schemes.map(({ codes: _codes, ...rest }) => rest)
  return `${tablesVersion}.${fnv1a(JSON.stringify(definitions))}`
}
