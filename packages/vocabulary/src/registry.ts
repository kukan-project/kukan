/**
 * KUKAN column vocabulary — the registry a site's enabled packs make
 * (ADR-073 §決定 7, §決定 8)
 */

import { fold, TRANSFORMS } from './fold'
import { intersect, isValidOn, overlap, union } from './period'
import type {
  CodeEntry,
  Name,
  CodeRepresentation,
  IsoDate,
  Level,
  NameRepresentation,
  Pack,
  Period,
  SchemeDefinition,
} from './types'

/**
 * The version of the inference rules: the matching, the thresholds, the
 * folding. Part of the registry state, so that a release changing only these
 * still rebuilds the inferences made under the old ones (ADR-073 §決定 4).
 */
export const RULES_VERSION = '2'

/**
 * A code, its level, and the spans in which a value named it: a set, so a code
 * retired and later given out again is not taken for valid in between.
 */
export interface Hit {
  code: string
  level: Level
  spans: Period[]
}

/**
 * What a folded name stands for: one place — with every code it went by, when
 * it was renumbered — or several it cannot be told between.
 */
export type NameIndexEntry = { hit: Hit; codes: string[] } | { ambiguous: true }

export interface IndexedScheme {
  pack: string
  def: SchemeDefinition
  /** Folded code → the place it names, over every period it was used in. */
  byCode: Map<string, Hit>
  byName: Map<string, NameIndexEntry>
  /** Folded values that stand for no area — totals, `全国` — left out of a name column's count. */
  notAreas: Set<string>
  codeReps: { rep: CodeRepresentation; whole: RegExp }[]
  nameReps: NameRepresentation[]
  /** Entries valid on the registry's date, per level: what coverage is counted against. */
  validNow: Map<Level, number>
  /**
   * Code → its parents' codes, nearest first, for each use of it: a ward's
   * city, then its prefecture; a code given out again may sit elsewhere.
   */
  ancestorsOf: Map<string, string[][]>
}

export interface Registry {
  /**
   * The rules' version and each enabled pack's, which a profile records so a
   * change of any of them can find the inferences to rebuild.
   */
  state: string
  schemes: IndexedScheme[]
  schemeById: Map<string, IndexedScheme>
  /**
   * The span of the codes written in digits alone, as numbers; null where no
   * scheme has any. An integer column outside it holds counts or amounts, and
   * need not be listed to know it names no code.
   */
  integerRange: { min: number; max: number } | null
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * The registry of the packs a site has enabled. No pack is enabled by default:
 * which country's codes a site reads is the site's setting, not the core's.
 *
 * @param today - the day coverage counts entries on, for tests
 */
export function createRegistry(
  packs: Pack[],
  today: IsoDate = new Date().toISOString().slice(0, 10)
): Registry {
  const ids = packs.map((p) => p.id)
  if (new Set(ids).size !== ids.length) throw new Error(`Pack enabled twice: ${ids.join(', ')}`)
  const versions = [...packs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}@${p.version}`)
  const digits = packs.flatMap((p) =>
    p.schemes.flatMap((s) => s.codes.flatMap((e) => (/^\d+$/.test(e.code) ? [Number(e.code)] : [])))
  )
  const schemes = packs.flatMap((pack) =>
    pack.schemes.map((def) => indexScheme(pack.id, def, today))
  )
  return {
    state: [`rules@${RULES_VERSION}`, ...versions].join(';'),
    schemes,
    schemeById: new Map(schemes.map((s) => [s.def.id, s])),
    integerRange:
      digits.length === 0
        ? null
        : {
            min: digits.reduce((a, b) => Math.min(a, b)),
            max: digits.reduce((a, b) => Math.max(a, b)),
          },
  }
}

function indexScheme(pack: string, def: SchemeDefinition, today: IsoDate): IndexedScheme {
  const repIds = def.representations.map((r) => r.id)
  if (new Set(repIds).size !== repIds.length) {
    throw new Error(`Representation named twice in ${def.id}: ${repIds.join(', ')}`)
  }
  const entries = new Map<string, CodeEntry[]>()
  for (const entry of def.codes) push(entries, entry.code, entry)

  const byCode = new Map<string, Hit>()
  for (const [code, list] of entries) {
    byCode.set(fold(def.codeFolding, code), { code, level: list[0].level, spans: union(list) })
  }

  const nameReps = def.representations.filter((r): r is NameRepresentation => r.kind === 'name')
  const named = new Map<string, Hit[]>()
  for (const entry of def.codes) {
    const chains = ancestorChains(entry, entries)
    for (const name of entry.names) {
      const spans = intersect([entry], [name])
      if (spans.length === 0) continue
      push(named, fold(def.nameFolding, name.text), { code: entry.code, level: entry.level, spans })
      for (const { qualified } of nameReps) {
        if (!qualified) continue
        for (const { chain, spans: pathSpans } of chains) {
          // Every name each ancestor had, so a prefecture renamed still qualifies
          // under its old name, and only while both names were in use
          for (const parents of namings(chain, name.lang)) {
            const both = parents.reduce(
              (acc, p) => intersect(acc, [p]),
              intersect(spans, pathSpans)
            )
            if (both.length === 0) continue
            const texts = parents.map((p) => p.text)
            const parts =
              qualified.order === 'parent-first'
                ? [...texts, name.text]
                : [name.text, ...texts.reverse()]
            push(named, fold(def.nameFolding, parts.join(qualified.separator)), {
              code: entry.code,
              level: entry.level,
              spans: both,
            })
          }
        }
      }
    }
  }
  const byName = new Map<string, NameIndexEntry>()
  for (const [key, hits] of named) byName.set(key, resolve(hits, entries, today))

  const ancestorsOf = new Map<string, string[][]>()
  for (const [code, list] of entries) {
    const paths = list.flatMap((entry) => ancestorPaths(entry, entries))
    const codes = paths.map((path) => path.map((e) => e.code).reverse())
    ancestorsOf.set(code, [...new Map(codes.map((up) => [up.join(), up])).values()])
  }

  const validNow = new Map<Level, number>()
  for (const entry of def.codes) {
    if (isValidOn(entry, today)) validNow.set(entry.level, (validNow.get(entry.level) ?? 0) + 1)
  }

  return {
    pack,
    def,
    byCode,
    byName,
    codeReps: def.representations
      .filter((r): r is CodeRepresentation => r.kind === 'code')
      .map((rep) => ({ rep, whole: new RegExp(`^(?:${rep.pattern})$`) })),
    nameReps,
    notAreas: new Set((def.notAreas ?? []).map((v) => fold(def.nameFolding, v))),
    validNow,
    ancestorsOf,
  }
}

/**
 * The place a name stands for. Several codes are one place when they took
 * turns under one parent — `浜松市`, whose code changed when it became a
 * designated city — and the name is then the code valid today, across every
 * span the name was in use: a 2005 table writing 浜松市 is not from 2007.
 * Otherwise they are several places (`府中市` in Tokyo and in Hiroshima, and
 * `大和町` in Miyagi and in Saga, one of them retired), which a value cannot
 * pick between.
 */
function resolve(hits: Hit[], entries: Map<string, CodeEntry[]>, today: IsoDate): NameIndexEntry {
  const perCode = new Map<string, Hit>()
  for (const h of hits) {
    const seen = perCode.get(h.code)
    perCode.set(h.code, seen ? { ...h, spans: union([...seen.spans, ...h.spans]) } : h)
  }
  const codes = [...perCode.values()]
  if (codes.length === 1) return { hit: codes[0], codes: [codes[0].code] }

  const parents = new Set(codes.map((h) => entries.get(h.code)?.[0]?.parent))
  const inTurn = codes.every((a, i) =>
    codes.every((b, j) => i === j || intersect(a.spans, b.spans).length === 0)
  )
  const current = codes.filter((h) => h.spans.some((p) => isValidOn(p, today)))
  if (parents.size !== 1 || !inTurn || current.length !== 1) return { ambiguous: true }
  const [{ code, level }] = current
  return {
    hit: { code, level, spans: union(codes.flatMap((h) => h.spans)) },
    codes: codes.map((h) => h.code),
  }
}

/**
 * Every way up from an entry, top first: each step to the parent entries whose
 * period meets the child's. A parent code retired and given out again is two
 * entries, which may sit under different grandparents, and a parent that moved
 * while the child was in it led up both ways in turn.
 */
function ancestorPaths(entry: CodeEntry, entries: Map<string, CodeEntry[]>): CodeEntry[][] {
  const paths: CodeEntry[][] = []
  const walk = (child: CodeEntry, path: CodeEntry[]) => {
    const parents = (child.parent ? (entries.get(child.parent) ?? []) : []).filter(
      (p) => !path.includes(p) && overlap(p, child) !== null
    )
    if (parents.length === 0) paths.push(path)
    for (const p of parents) walk(p, [p, ...path])
  }
  walk(entry, [])
  // Each step meeting its child is not the whole way meeting at once: a ward
  // made after its town's region was gone was never in that region
  return paths.filter(
    (path) => path.reduce<Period[]>((acc, e) => intersect(acc, [e]), [entry]).length > 0
  )
}

/**
 * The ancestors a name can be written with, top first: each one alone and each
 * run of them — `北海道`, `札幌市` and `北海道 札幌市` for a ward of Sapporo —
 * along each of its `ancestorPaths`.
 */
function ancestorChains(
  entry: CodeEntry,
  entries: Map<string, CodeEntry[]>
): { chain: CodeEntry[]; spans: Period[] }[] {
  const paths = ancestorPaths(entry, entries)
  // Every subsequence of each path in order: few, since schemes are a handful
  // of levels deep and codes are seldom reused. A subsequence keeps the span of
  // its whole path, so an ancestor left out of the name still bounds it — the
  // city's own county, when the city changed counties
  const chains = new Map<string, { chain: CodeEntry[]; spans: Period[] }>()
  for (const path of paths) {
    const spans = path.reduce<Period[]>((acc, e) => intersect(acc, [e]), [entry])
    for (const chain of path.reduce<CodeEntry[][]>(
      (subs, a) => [...subs, ...subs.map((s) => [...s, a])],
      [[]]
    )) {
      if (chain.length === 0) continue
      const key = chain.map(entryKey).join('|')
      const seen = chains.get(key)
      chains.set(key, { chain, spans: seen ? union([...seen.spans, ...spans]) : spans })
    }
  }
  return [...chains.values()]
}

/** One entry's identity among the reuses of its code. */
const entryKey = (e: CodeEntry) => `${e.code}@${e.validFrom ?? ''}`

/** Each way the chain's names could be written together: every official name of each, with its span. */
function namings(chain: CodeEntry[], lang: string): Name[][] {
  return chain.reduce<Name[][]>(
    (combos, e) => {
      const names = e.names
        .filter((n) => n.kind === 'official' && n.lang === lang)
        .flatMap((n) => intersect([e], [n]).map((span) => ({ ...n, ...span })))
      return combos.flatMap((c) => names.map((n) => [...c, n]))
    },
    [[]]
  )
}

/**
 * The code a value already folded by the scheme stands for in `rep`, as the
 * table's folded key, or null when it is not one.
 */
export function canonicalCode(
  scheme: IndexedScheme,
  { rep, whole }: { rep: CodeRepresentation; whole: RegExp },
  folded: string
): string | null {
  if (!whole.test(folded)) return null
  const padded = rep.padEnd === undefined ? folded : folded.padEnd(rep.padEnd, '0')
  if (rep.toCanonical === undefined) return padded
  const code = TRANSFORMS[rep.toCanonical].apply(scheme.def.checkDigit, padded)
  return code === null ? null : fold(scheme.def.codeFolding, code)
}

/** Whether a value written in `rep` carries the digit that checks it. */
export function carriesCheckDigit(scheme: IndexedScheme, rep: CodeRepresentation): boolean {
  return (
    scheme.def.checkDigit !== undefined &&
    (rep.toCanonical === undefined || TRANSFORMS[rep.toCanonical].carriesCheckDigit)
  )
}
