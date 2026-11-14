/**
 * KUKAN column vocabulary — periods, half-open: from inclusive, to exclusive,
 * and open on a side left out
 */

import type { IsoDate, Period } from './types'

export const isValidOn = (p: Period, day: IsoDate) =>
  (p.validFrom === undefined || p.validFrom <= day) && (p.validTo === undefined || day < p.validTo)

const bounds = (validFrom?: IsoDate, validTo?: IsoDate): Period => ({
  ...(validFrom !== undefined && { validFrom }),
  ...(validTo !== undefined && { validTo }),
})

/** The span both share, or null when they share none. */
export function overlap(a: Period, b: Period): Period | null {
  const from = [a.validFrom, b.validFrom]
    .filter((d) => d !== undefined)
    .sort()
    .at(-1)
  const to = [a.validTo, b.validTo].filter((d) => d !== undefined).sort()[0]
  return from !== undefined && to !== undefined && from >= to ? null : bounds(from, to)
}

/** The span covering both, open on any side either is open on. */
export function hull(a: Period, b: Period): Period {
  return bounds(
    a.validFrom === undefined || b.validFrom === undefined
      ? undefined
      : [a.validFrom, b.validFrom].sort()[0],
    a.validTo === undefined || b.validTo === undefined
      ? undefined
      : [a.validTo, b.validTo].sort().at(-1)
  )
}

const startOf = (p: Period) => p.validFrom ?? ''
const endsBefore = (a: Period, b: Period) =>
  a.validTo !== undefined && b.validFrom !== undefined && a.validTo < b.validFrom

/**
 * Periods as a set: sorted, and merged where they touch or overlap, so a gap
 * between them — a code retired and later given out again — stays a gap.
 */
export function union(periods: Period[]): Period[] {
  const out: Period[] = []
  for (const p of [...periods].sort((a, b) => startOf(a).localeCompare(startOf(b)))) {
    const last = out.at(-1)
    if (last && !endsBefore(last, p)) out[out.length - 1] = hull(last, p)
    else out.push(p)
  }
  return out
}

/** The span two sets share, as a set; empty when they share none. */
export function intersect(a: Period[], b: Period[]): Period[] {
  return union(a.flatMap((x) => b.flatMap((y) => overlap(x, y) ?? [])))
}
