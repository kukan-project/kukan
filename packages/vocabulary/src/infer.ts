/**
 * KUKAN column vocabulary — matching a column's values, and what a column alone
 * can be said to be (ADR-073 §決定 4, §決定 5)
 */

import { fold } from './fold'
import { intersect } from './period'
import {
  canonicalCode,
  carriesCheckDigit,
  type Hit,
  type IndexedScheme,
  type Registry,
} from './registry'
import type { Concept, Level, Period, Representation } from './types'

/** How one representation of one scheme fares against a column's values. */
export interface RepresentationMatch {
  scheme: IndexedScheme
  rep: Representation
  /** Distinct values looked at, counted after folding: `010006` and `０１０００６` are one. */
  values: number
  /** Values that name more than one place, counted toward neither the share nor the coverage. */
  ambiguous: number
  /** One per value that named a single place: its code, and the span the value points to. */
  hits: Hit[]
}

/**
 * Every representation of every scheme against a column's values, or those
 * `wanted` says. Values are compared as given: a code is not padded with
 * zeros here, since a zero the file never had is no evidence (ADR-073 §試行).
 */
export function matchValues(
  registry: Registry,
  values: string[],
  wanted: (scheme: IndexedScheme, rep: Representation) => boolean = () => true
): RepresentationMatch[] {
  const folded = new Map<string, string[]>()
  const distinct = (foldings: Parameters<typeof fold>[0]) => {
    const key = foldings.join()
    let out = folded.get(key)
    if (!out) {
      out = [...new Set(values.map((v) => fold(foldings, v)).filter((v) => v !== ''))]
      folded.set(key, out)
    }
    return out
  }

  const out: RepresentationMatch[] = []
  for (const scheme of registry.schemes) {
    const codes = distinct(scheme.def.codeFolding)
    for (const cr of scheme.codeReps) {
      if (!wanted(scheme, cr.rep)) continue
      const hits: Hit[] = []
      for (const v of codes) {
        const key = canonicalCode(scheme, cr, v)
        const hit = key === null ? undefined : scheme.byCode.get(key)
        if (hit) hits.push(hit)
      }
      out.push({ scheme, rep: cr.rep, values: codes.length, ambiguous: 0, hits })
    }

    const reps = scheme.nameReps.filter((rep) => wanted(scheme, rep))
    if (reps.length === 0) continue
    // A total or `全国` is no name of a place, so not a name that failed to match
    const names = distinct(scheme.def.nameFolding).filter((v) => !scheme.notAreas.has(v))
    const hits: Hit[] = []
    let ambiguous = 0
    for (const v of names) {
      const found = scheme.byName.get(v)
      if (!found) continue
      if ('ambiguous' in found) ambiguous++
      else hits.push(found.hit)
    }
    for (const rep of reps) out.push({ scheme, rep, values: names.length, ambiguous, hits })
  }
  return out
}

/** What the matched codes say about the column, beyond which scheme they are in. */
export interface CodeSummary {
  /** Per level present: places matched, and the level's entries valid on the registry's date. */
  levels: { level: Level; matched: number; total: number }[]
  /**
   * The spans the values all point to, as a set: `[{}]` is consistent with the
   * scheme as it stands, `[]` is values from different times with none shared,
   * and several are a reused code's uses with the gap between them kept.
   */
  periods: Period[]
  /** The codes whose span narrowed the period, its evidence. */
  narrowedBy: string[]
}

export function summarizeCodes(scheme: IndexedScheme, hits: Hit[]): CodeSummary {
  const perLevel = new Map<Level, Set<string>>()
  for (const { code, level } of hits) {
    perLevel.set(level, (perLevel.get(level) ?? new Set()).add(code))
  }
  const levels = [...perLevel].map(([level, codes]) => ({
    level,
    matched: codes.size,
    total: scheme.validNow.get(level) ?? 0,
  }))
  // The spans every value shares, as a set: a reused code's gap stays a gap
  const periods = hits.reduce<Period[]>((acc, h) => intersect(acc, h.spans), [{}])
  const bounds = new Set(periods.flatMap((p) => [p.validFrom, p.validTo]))
  bounds.delete(undefined)
  const narrowedBy = hits
    .filter((h) => h.spans.some((p) => bounds.has(p.validFrom) || bounds.has(p.validTo)))
    .map((h) => h.code)
  return { levels, periods, narrowedBy: [...new Set(narrowedBy)] }
}

/**
 * What a column alone has to show (ADR-073 §決定 5). A code carrying its own
 * check digit needs no heading and may be the one value of the column — the
 * standard open data sets repeat their own code down every row. A name needs
 * more of its values to match, since names are written with more variation,
 * and several of them: one or two names of prefectures are as likely surnames.
 * Codes without a check digit of their own are not inferred from the column
 * alone: their values are too common.
 */
export const INFERENCE_RULES = {
  checkedCode: { share: 0.9, minValues: 1 },
  name: { share: 0.8, minValues: 3 },
} as const

const ruleFor = (scheme: IndexedScheme, rep: Representation) =>
  rep.kind === 'name'
    ? INFERENCE_RULES.name
    : carriesCheckDigit(scheme, rep)
      ? INFERENCE_RULES.checkedCode
      : null

export interface ColumnInference {
  concept: Concept
  pack: string
  scheme: string
  representation: string
  /** Values naming a single place, over distinct values looked at. */
  share: number
  ambiguous: number
  summary: CodeSummary
}

/**
 * What a column can be said to be from its own values, best first. More than
 * one scheme reaching its share is a column to leave for a person: it is
 * returned whole, and the caller reads it as candidates, not an answer.
 */
export function inferColumn(registry: Registry, values: string[]): ColumnInference[] {
  return matchValues(registry, values, (scheme, rep) => ruleFor(scheme, rep) !== null)
    .filter((m) => {
      const rule = ruleFor(m.scheme, m.rep)!
      return m.values >= rule.minValues && m.hits.length / m.values >= rule.share
    })
    .map((m) => ({
      concept: m.scheme.def.concept,
      pack: m.scheme.pack,
      scheme: m.scheme.def.id,
      representation: m.rep.id,
      share: m.hits.length / m.values,
      ambiguous: m.ambiguous,
      summary: summarizeCodes(m.scheme, m.hits),
    }))
    .sort((a, b) => b.share - a.share)
}
