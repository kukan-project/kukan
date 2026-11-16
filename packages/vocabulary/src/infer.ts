/**
 * KUKAN column vocabulary — matching a column's values, and what a column alone
 * can be said to be (ADR-073 §決定 4, §決定 5)
 */

import { fold } from './fold'
import { intersect } from './period'
import {
  canonicalCode,
  codesOf,
  isNotArea,
  liesIn,
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
    const names = distinct(scheme.def.nameFolding).filter((v) => !isNotArea(scheme, v))
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
  /**
   * `shortShare`: the least a column of codes may have and still be borne out.
   * A statistics table puts groups of places among its places, whose codes are
   * in no code table: names beside the rest are what settles such a column.
   */
  checkedCode: { share: 0.9, minValues: 1, shortShare: 0.8 },
  /**
   * `alone`: places below the top level, or fewer spread under several at the
   * top. A serial number runs through Japan's codes as far as 42 matches before
   * its share falls under 0.9 (measured on the code table, 2026-11-15); a run
   * from 13101 is every ward of Tokyo, but under one prefecture.
   */
  uncheckedCode: {
    share: 0.9,
    minValues: 1,
    shortShare: 0.8,
    alone: { values: 50, spread: { values: 20, roots: 2 } },
  },
  /**
   * A name several places share is left out of the share, but not without
   * bound: `overAll` is the share with those counted as misses. A column of
   * town names that cities share would otherwise be decided by its few others.
   */
  name: { share: 0.8, minValues: 3, overAll: 0.5 },
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
  const below = hits.filter((h) => topsOf(scheme, h.code).length > 0)
  return (
    below.length >= alone.values ||
    (below.length >= alone.spread.values &&
      new Set(below.flatMap((h) => topsOf(scheme, h.code))).size >= alone.spread.roots)
  )
}

export interface ColumnInference {
  concept: Concept
  pack: string
  scheme: string
  representation: string
  /** A code is an identifier to search by; a name stays a word to search for. */
  kind: Representation['kind']
  /**
   * Values naming a single place, over those naming one place or none: a name
   * several places share says nothing either way (ADR-073 §決定 5).
   */
  share: number
  ambiguous: number
  summary: CodeSummary
  /** Whether the values settle it; a short code that does not awaits a heading or names. */
  standsAlone: boolean
  /** Short of its share, as a column of codes with groups among them is: names alone settle it. */
  shortOfShare: boolean
  /** The places matched, by code, sorted: what a search by area finds the table by. */
  places: string[]
  /** The top-level places they lie in — a prefecture's own code is its own top. */
  roots: string[]
}

/** The top-level places a place lies in; none for a top-level place itself. */
const topsOf = (scheme: IndexedScheme, code: string) =>
  (scheme.ancestorsOf.get(code) ?? []).flatMap((up) => up.slice(-1))

/** The places of the hits, and the top-level places they lie in, each sorted once. */
function placesOf(scheme: IndexedScheme, hits: Hit[]): { places: string[]; roots: string[] } {
  const places = [...new Set(hits.map((h) => h.code))].sort()
  const roots = places.flatMap((code) => {
    const tops = topsOf(scheme, code)
    return tops.length > 0 ? tops : [code]
  })
  return { places, roots: [...new Set(roots)].sort() }
}

/**
 * What a column's own values say it may be, best first. More than one scheme
 * reaching its share is a column to leave for a person: it is returned whole,
 * and the caller reads it as candidates, not an answer.
 */
export function inferColumn(registry: Registry, values: string[]): ColumnInference[] {
  return matchValues(registry, values)
    .flatMap((m): ColumnInference[] => {
      const rule = ruleFor(m.scheme, m.rep)
      const counted = m.values - m.ambiguous
      if (counted < rule.minValues) return []
      const share = m.hits.length / counted
      const short = share < rule.share
      if (short && !('shortShare' in rule && share >= rule.shortShare)) return []
      if ('overAll' in rule && m.hits.length / m.values < rule.overAll) return []
      return [
        {
          concept: m.scheme.def.concept,
          pack: m.scheme.pack,
          scheme: m.scheme.def.id,
          representation: m.rep.id,
          kind: m.rep.kind,
          // Two places are enough for a stored profile, and down, so a share
          // the rules found short never reads as one that reached them
          share: Math.floor(share * 100) / 100,
          ambiguous: m.ambiguous,
          summary: summarizeCodes(m.scheme, m.hits),
          standsAlone: !short && standsAlone(m),
          shortOfShare: short,
          ...placesOf(m.scheme, m.hits),
        },
      ]
    })
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
    // A heading naming the representation settles it and names its codes too,
    // unless the column is short of its share: only names can account for that
    const named = !f.shortOfShare && rep?.kind === 'code' && headingNames(heading, rep.headings)
    if (one && !named && !headingNames(heading, def.codeHeadings)) return []
    return [named ? { ...f, standsAlone: true } : f]
  })
  const [first, ...rest] = found.filter((f) => f.standsAlone)
  if (first) return verdictOf([first, ...rest])
  return found.length === 0 ? null : { unconfirmed: found }
}

/**
 * The place a code column's value names, by a pair's code: null where it is
 * not a code of the candidate's representation, or one the table lacks.
 */
function placeOfCode(scheme: IndexedScheme, candidate: ColumnInference, code: string | null) {
  const rep = scheme.codeReps.find((r) => r.rep.id === candidate.representation)
  const key = rep && code !== null && canonicalCode(scheme, rep, fold(scheme.def.codeFolding, code))
  return (key && scheme.byCode.get(key)) || null
}

/**
 * Whether a column of names in the same table bears out a code column's
 * candidate: on nearly every row where both name a place, the code is that
 * place — under any code it went by, or as one of the places a shared name may
 * be — or one it lies in, as a prefecture's code beside its cities' names.
 *
 * @param pairs - the table's distinct pairs of the code column's value and the
 *   name column's, as written.
 */
export function corroborate(
  registry: Registry,
  candidate: ColumnInference,
  pairs: [code: string | null, name: string][]
): boolean {
  const scheme = registry.schemeById.get(candidate.scheme)
  if (!scheme) return false
  let both = 0
  let agreed = 0
  const codes = new Set<string>()
  for (const [code, name] of pairs) {
    const byCode = placeOfCode(scheme, candidate, code)
    const byName = scheme.byName.get(fold(scheme.def.nameFolding, name))
    if (!byCode || !byName) continue
    both++
    if (!codesOf(byName).some((c) => liesIn(scheme, c, byCode.code))) continue
    agreed++
    codes.add(byCode.code)
  }
  const { share, minPairs, minCodes } = INFERENCE_RULES.corroboration
  return agreed >= minPairs && codes.size >= minCodes && agreed / both >= share
}

/**
 * A column of names read beside a column of codes (ADR-073 §決定 5): a name
 * several places share is the one its row's code names, or lies in — 中央区
 * beside 13102 is Tokyo's. A name on a row with no code counts as it would
 * alone. Null where the names do not reach the share even so.
 *
 * @param codes - the code column's inference, settled or borne out.
 * @param pairs - as {@link corroborate} takes them, rows with no code included.
 */
export function judgeNamesByCodes(
  registry: Registry,
  codes: ColumnInference,
  pairs: [code: string | null, name: string][]
): ColumnInference | null {
  const scheme = registry.schemeById.get(codes.scheme)
  const rep = scheme?.nameReps[0]
  if (!scheme || !rep) return null
  // Each name, and the places its rows' codes name
  const rows = new Map<string, Hit[]>()
  for (const [code, name] of pairs) {
    const folded = fold(scheme.def.nameFolding, name)
    if (folded === '' || isNotArea(scheme, folded)) continue
    const coded = rows.get(folded) ?? rows.set(folded, []).get(folded)!
    const byCode = placeOfCode(scheme, codes, code)
    if (byCode) coded.push(byCode)
  }
  const hits: Hit[] = []
  let named = 0
  let ambiguous = 0
  for (const [name, coded] of rows) {
    const entry = scheme.byName.get(name)
    if (!entry) continue
    // A row's code picks the one place of the name that lies in it, and a
    // code as wide as a prefecture may leave two (大阪市北区 and 堺市北区 in 27).
    // A name shared by places in two prefectures may be both in one table
    const picked =
      'ambiguous' in entry
        ? [
            ...new Set(
              coded.flatMap((c) => {
                const inside = entry.hits.filter((h) => liesIn(scheme, h.code, c.code))
                return inside.length === 1 ? inside : []
              })
            ),
          ]
        : [entry.hit]
    if (picked.length === 0) ambiguous++
    else {
      named++
      hits.push(...picked)
    }
  }
  const rule = INFERENCE_RULES.name
  const share = named / rows.size
  if (rows.size < rule.minValues || share < rule.share) return null
  return {
    concept: scheme.def.concept,
    pack: scheme.pack,
    scheme: scheme.def.id,
    representation: rep.id,
    kind: 'name',
    share: Math.floor(share * 100) / 100,
    ambiguous,
    summary: summarizeCodes(scheme, hits),
    standsAlone: true,
    shortOfShare: false,
    ...placesOf(scheme, hits),
  }
}

/**
 * The values of a column that are names several places of a scheme share:
 * those a reading by codes has to pick between, and so the rows to read whole.
 */
export function sharedNames(registry: Registry, scheme: string, values: string[]): string[] {
  const indexed = registry.schemeById.get(scheme)
  if (!indexed) return []
  return values.filter((v) => {
    const entry = indexed.byName.get(fold(indexed.def.nameFolding, v))
    return entry !== undefined && 'ambiguous' in entry
  })
}

/** Whether a reading is better evidence than one held: a higher share, or as high with fewer names undecided. */
export function outranks(
  read: { share: number; ambiguous: number },
  held: { share: number; ambiguous: number }
): boolean {
  return read.share > held.share || (read.share === held.share && read.ambiguous < held.ambiguous)
}

/**
 * The schemes a column's values are names of, in part at least: as many as a
 * column of names needs, naming one place or several — counted with the
 * shared names, which a column of codes beside it may yet pick between. What a column has to
 * show to be read beside a column of codes, though it decides nothing alone.
 */
export function nameSchemes(registry: Registry, values: string[]): string[] {
  return matchValues(registry, values)
    .filter(
      (m) => m.rep.kind === 'name' && m.hits.length + m.ambiguous >= INFERENCE_RULES.name.minValues
    )
    .map((m) => m.scheme.def.id)
}
