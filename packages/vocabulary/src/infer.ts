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
import type { Concept, Folding, Level, Period, Representation } from './types'

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
 * Every representation of every scheme against a column's values. Values are
 * compared as given: a code is not padded with zeros here, since a zero the
 * file never had is no evidence (ADR-073 §試行).
 */
export function matchValues(registry: Registry, values: string[]): RepresentationMatch[] {
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
      const hits: Hit[] = []
      for (const v of codes) {
        const key = canonicalCode(scheme, cr, v)
        const hit = key === null ? undefined : scheme.byCode.get(key)
        if (hit) hits.push(hit)
      }
      out.push({ scheme, rep: cr.rep, values: codes.length, ambiguous: 0, hits })
    }

    if (scheme.nameReps.length === 0) continue
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
    for (const rep of scheme.nameReps)
      out.push({ scheme, rep, values: names.length, ambiguous, hits })
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
 * What a column has to show (ADR-073 §決定 5). A code carrying its own check
 * digit needs no heading and may be the one value of the column — the standard
 * open data sets repeat their own code down every row. A name needs more of its
 * values to match, since names are written with more variation, and several of
 * them: one or two names of prefectures are as likely surnames.
 *
 * A code without a check digit of its own has values too common to go by:
 * almost any column of days, ages or counts is two-digit prefecture codes. Its
 * values decide it only when many name places below the top level — the top
 * level is so few that a month's days are 31 prefectures — and otherwise it
 * needs a heading naming the way it is written, or a column of names in the
 * same table that agrees with it row by row.
 */
export const INFERENCE_RULES = {
  checkedCode: { share: 0.9, minValues: 1 },
  /**
   * `alone`: places below the top level, or fewer spread under several at the
   * top. A serial number runs through Japan's codes as far as 42 matches before
   * its share falls under 0.9 (measured on the code table, 2026-11-15); a run
   * from 13101 is every ward of Tokyo, but under one prefecture.
   */
  uncheckedCode: {
    share: 0.9,
    minValues: 1,
    alone: { values: 50, spread: { values: 20, roots: 2 } },
  },
  name: { share: 0.8, minValues: 3 },
  /**
   * Pairs a column of codes and one of names have to agree on, of those where
   * both name a place, and the codes among them: one value down a table of one
   * prefecture's cities agrees with every row, whatever it stands for. And the
   * rows the pairs are drawn from, far more than that needs.
   */
  corroboration: { share: 0.9, minPairs: 3, minCodes: 2, sampleRows: 10_000 },
  /**
   * The most distinct values a column may have and be read at all: more than
   * any one level of a country's areas, so a column past it is addresses or
   * identifiers of something else, and listing it costs more than it tells.
   */
  maxValues: 5_000,
} as const

const ruleFor = (scheme: IndexedScheme, rep: Representation) =>
  rep.kind === 'name'
    ? INFERENCE_RULES.name
    : carriesCheckDigit(scheme, rep)
      ? INFERENCE_RULES.checkedCode
      : INFERENCE_RULES.uncheckedCode

/** Whether a match's values settle it with nothing else to go by. */
function standsAlone({ scheme, rep, hits }: RepresentationMatch): boolean {
  if (rep.kind === 'name' || carriesCheckDigit(scheme, rep)) return true
  const { alone } = INFERENCE_RULES.uncheckedCode
  const tops = (code: string) => (scheme.ancestorsOf.get(code) ?? []).flatMap((up) => up.slice(-1))
  const below = hits.filter((h) => tops(h.code).length > 0)
  return (
    below.length >= alone.values ||
    (below.length >= alone.spread.values &&
      new Set(below.flatMap((h) => tops(h.code))).size >= alone.spread.roots)
  )
}

export interface ColumnInference {
  concept: Concept
  pack: string
  scheme: string
  representation: string
  /** A code is an identifier to search by; a name stays a word to search for. */
  kind: Representation['kind']
  /** Values naming a single place, over distinct values looked at. */
  share: number
  ambiguous: number
  summary: CodeSummary
  /** Whether the values settle it; a short code that does not awaits a heading or names. */
  standsAlone: boolean
}

/**
 * What a column's own values say it may be, best first. More than one scheme
 * reaching its share is a column to leave for a person: it is returned whole,
 * and the caller reads it as candidates, not an answer.
 */
export function inferColumn(registry: Registry, values: string[]): ColumnInference[] {
  return matchValues(registry, values)
    .filter((m) => {
      const rule = ruleFor(m.scheme, m.rep)
      return m.values >= rule.minValues && m.hits.length / m.values >= rule.share
    })
    .map((m) => ({
      concept: m.scheme.def.concept,
      pack: m.scheme.pack,
      scheme: m.scheme.def.id,
      representation: m.rep.id,
      kind: m.rep.kind,
      // Two places are enough: the share is compared at a tenth, and a stored
      // profile need not carry fifteen digits of it
      share: Math.round((m.hits.length / m.values) * 100) / 100,
      ambiguous: m.ambiguous,
      summary: summarizeCodes(m.scheme, m.hits),
      standsAlone: standsAlone(m),
    }))
    .sort((a, b) => b.share - a.share)
}

/** What is known of a column besides its values. */
export interface ColumnContext {
  heading: string
  /** Typed as integers by the reader, which a code column is when no value kept a leading zero. */
  integer: boolean
}

/** One scheme decided, or several left for a person — the first being no answer. */
export type SettledVerdict = { decided: ColumnInference } | { candidates: ColumnInference[] }

/**
 * A column's verdict (ADR-073 §決定 4・5): settled, or short codes that only a
 * column of names in the same table can still bear out.
 */
export type ColumnVerdict = SettledVerdict | { unconfirmed: ColumnInference[] }

/** Settled inferences as a verdict. */
export function verdictOf(settled: [ColumnInference, ...ColumnInference[]]): SettledVerdict {
  return new Set(settled.map((f) => f.scheme)).size === 1
    ? { decided: settled[0] }
    : { candidates: settled }
}

const HEADING_FOLDING: Folding[] = ['nfkc', 'lowercase']
const headingNames = (heading: string, words: string[] = []) =>
  words.some((w) => heading.includes(fold(HEADING_FOLDING, w)))

/**
 * What a column is taken to be, or null when nothing in the registry fits it.
 *
 * One integer repeated down a column is taken for a code only under a heading
 * that names the scheme's codes: a month written `202011` checks out as a code
 * as often as a code does, and a single value is all the evidence there is.
 */
export function judgeColumn(
  registry: Registry,
  values: string[],
  context: ColumnContext
): ColumnVerdict | null {
  const distinct = new Set(values).size
  if (distinct === 0 || distinct > INFERENCE_RULES.maxValues) return null
  const heading = fold(HEADING_FOLDING, context.heading)
  const one = context.integer && distinct === 1
  const found = inferColumn(registry, values).flatMap((f) => {
    const def = registry.schemeById.get(f.scheme)!.def
    const rep = def.representations.find((r) => r.id === f.representation)
    // A heading naming the representation settles it, and names its codes too
    const named = rep?.kind === 'code' && headingNames(heading, rep.headings)
    if (one && !named && !headingNames(heading, def.codeHeadings)) return []
    return [named ? { ...f, standsAlone: true } : f]
  })
  const [first, ...rest] = found.filter((f) => f.standsAlone)
  if (first) return verdictOf([first, ...rest])
  return found.length === 0 ? null : { unconfirmed: found }
}

/**
 * Whether a column of names in the same table bears out a code column's
 * candidate: on nearly every row where both name a place, the code is that
 * place — under any code it went by — or one it lies in, as a prefecture's
 * code beside the names of its cities.
 *
 * @param pairs - the table's distinct pairs of the code column's value and the
 *   name column's, as written.
 */
export function corroborate(
  registry: Registry,
  candidate: ColumnInference,
  pairs: [code: string, name: string][]
): boolean {
  const scheme = registry.schemeById.get(candidate.scheme)
  const rep = scheme?.codeReps.find((r) => r.rep.id === candidate.representation)
  if (!scheme || !rep) return false
  let both = 0
  let agreed = 0
  const codes = new Set<string>()
  for (const [code, name] of pairs) {
    const key = canonicalCode(scheme, rep, fold(scheme.def.codeFolding, code))
    const byCode = key === null ? undefined : scheme.byCode.get(key)
    const byName = scheme.byName.get(fold(scheme.def.nameFolding, name))
    if (!byCode || !byName || 'ambiguous' in byName) continue
    both++
    const within = (c: string) =>
      c === byCode.code || (scheme.ancestorsOf.get(c) ?? []).some((up) => up.includes(byCode.code))
    if (!byName.codes.some(within)) continue
    agreed++
    codes.add(byCode.code)
  }
  const { share, minPairs, minCodes } = INFERENCE_RULES.corroboration
  return agreed >= minPairs && codes.size >= minCodes && agreed / both >= share
}
