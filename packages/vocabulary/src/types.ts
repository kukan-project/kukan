/**
 * KUKAN column vocabulary — the shapes a pack is written in (ADR-073 §決定 1–3)
 *
 * Nothing here is a country's: a scheme's check digit, foldings and transforms
 * are chosen from closed lists, and a pack is data in these shapes.
 */

/** What a column means, whatever country it comes from. Few, and only grown by the product. */
export type Concept = 'admin-area'

/**
 * The generic levels of an administrative area (ADM1–3), which absorb what each
 * country calls its own: a prefecture and a state are both ADM1.
 */
export const LEVELS = ['ADM1', 'ADM2', 'ADM3'] as const
export type Level = (typeof LEVELS)[number]

/** An ISO 8601 date, `YYYY-MM-DD`. */
export type IsoDate = string

/** Half-open: from inclusive, to exclusive; a side left out is open. */
export interface Period {
  validFrom?: IsoDate
  validTo?: IsoDate
}

export interface Name extends Period {
  text: string
  /** BCP 47: `ja`, `en`, `zh-Hant`. */
  lang: string
  kind: 'official' | 'alias' | 'romanized'
  /** The romanization system, for `romanized`: `hepburn`, `pinyin`. */
  system?: string
}

/**
 * One row of a code table. Its parent is given, not worked out from the code:
 * a pack's generator knows how its country writes parents, and the core
 * carries no rule for it. A code retired and later reused is two entries.
 */
export interface CodeEntry extends Period {
  code: string
  level: Level
  /** The parent's code in the same scheme; absent at the top. */
  parent?: string
  /** Names of the area alone (`中央区`, `Camden`), not qualified by its parents. */
  names: Name[]
}

/** Check digit rules a scheme can name. Closed: a new one is a change to the product. */
export type CheckDigitRule = 'mod11-weights-6-2'

/** How a value is folded before it is compared, for codes and names alike. Closed. */
export type Folding = 'nfkc' | 'strip-spaces' | 'lowercase' | 'uppercase' | 'small-kana-ke'

/** How a value written one way becomes the code a table holds. Closed. */
export type Transform = 'append-check-digit'

/** A way of writing a code. Values are matched whole after the scheme's code folding. */
export interface CodeRepresentation {
  id: string
  kind: 'code'
  /** The whole value, as a regular expression without anchors. */
  pattern: string
  /**
   * The length a value is filled out to with zeros at its end before
   * `toCanonical`: a prefecture's `13` is the `13000` its code is made from.
   */
  padEnd?: number
  /** Absent: the value is the code. */
  toCanonical?: Transform
  /**
   * Words a heading names this way of writing by (`都道府県コード`): enough for a
   * code with no check digit, unlike the scheme's bare `codeHeadings`.
   */
  headings?: string[]
}

/** Writing the area by name. */
export interface NameRepresentation {
  id: string
  kind: 'name'
  /**
   * How a name is written with its parents': `北海道札幌市` puts them first
   * with nothing between, `Camden, London` after with a comma. Absent where the
   * scheme's country does not write them together.
   */
  qualified?: { separator: string; order: 'parent-first' | 'child-first' }
}

export type Representation = CodeRepresentation | NameRepresentation

export interface SchemeDefinition {
  /** Unique across packs: `jp-lg-code`. */
  id: string
  concept: Concept
  label: Record<string, string>
  publisher: string
  /** The terms the code table is published under, and whether it may be changed. */
  license: { name: string; url: string; derivatives: boolean }
  source: { url: string; retrieved: IsoDate }
  checkDigit?: CheckDigitRule
  codeFolding: Folding[]
  nameFolding: Folding[]
  representations: Representation[]
  /**
   * Values a column of names holds that stand for no area — `全国`, `合計` —
   * which are left out of the count a share is taken over (ADR-073 §決定 5).
   */
  notAreas?: string[]
  /**
   * The same, as regular expressions matched whole against the folded value,
   * for the kinds a list cannot hold: a prefecture's branch offices (`大島支庁`).
   */
  notAreaPatterns?: string[]
  /**
   * Words a column heading uses for the scheme's codes (`コード`, `code`),
   * folded and found anywhere in it. What lets one integer repeated down a
   * column be read as a code (ADR-073 §決定 5).
   */
  codeHeadings?: string[]
  codes: CodeEntry[]
}

/** How one area relates to another across time or across schemes (ADR-073 §決定 3). */
export interface Correspondence {
  from: { scheme: string; code: string; at?: IsoDate }
  to: { scheme: string; code: string; at?: IsoDate }
  /** The share of `from` that lies in `to`, 0–1. */
  ratio: number
  basis: 'area' | 'population' | 'count' | 'none'
}

/** A country's or region's schemes, enabled per site. */
export interface Pack {
  /** ISO 3166-1 alpha-2, or a region's code. Never a display name. */
  id: string
  /** Changes whenever the data does; part of the registry state a profile records. */
  version: string
  schemes: SchemeDefinition[]
  correspondences: Correspondence[]
}
