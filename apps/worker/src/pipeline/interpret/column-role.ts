/**
 * KUKAN Pipeline — column roles (ADR-063 §決定 1)
 *
 * Decides what a text column is from counts DuckDB took over it. Rules only,
 * no AI: the same counts give the same role on every run and in every
 * deployment, and a wrong role costs a search hit, never data. The thresholds
 * are where the spike over 5,352 columns left them (ADR-063 試行).
 */

import type { ColumnRole, ColumnRoleBasis } from '@kukan/shared'

/**
 * What was counted over a text column's values, trimmed. Every share is of
 * the non-blank values, 0–1.
 */
export interface TextColumnClues {
  /** Values present; nought where every one is blank. */
  count: number
  /** Distinct values. */
  distinct: number
  avgLength: number
  minLength: number
  maxLength: number
  /** ASCII letters, digits and `._/:-` only. */
  ascii: number
  /** Digits only, half- or full-width. */
  digits: number
  /** Any digit, half- or full-width — what a code has and a name mostly does not. */
  digit: number
  /** The share of a value's characters that are digits, averaged over the values. */
  digitChars: number
  /** Japanese punctuation (`。、．，`). */
  punctuation: number
  /**
   * The shape of a sentence: a run of two or more hiragana, or six or more
   * words — what prose has and names mostly do not, in Japanese and in English.
   */
  prose: number
  url: number
  phone: number
  /** `2026/5/12`, `令和6年4月`, `H31.4.1` and the like. */
  date: number
  /** A number with commas, brackets, a sign, a percent — or only dashes and dots. */
  number: number
}

/** Headings that say what the column is, where the values alone leave it open. */
// English only as the whole heading: `cuisine_description` holds cuisines, not prose
const FREE_TEXT_HINT =
  /備考|概要|説明|内容|コメント|摘要|特記|注記|詳細|理由|メモ|^(remarks?|notes?|description|comments?|details|memo)$/i
// Case matters for `ID`: folded, it is in Provider and Width. Lower case only as
// a word of its own, as in `user_id`.
const IDENTIFIER_HINT = /コード|番号|ＩＤ|ID|Ｎｏ|No\.?$|識別|郵便|(^|[_\s-])id$/

export interface RoleDecision {
  role: ColumnRole
  roleBasis: ColumnRoleBasis
}

/** Rounded so a schema does not carry fifteen digits of a share. */
const share = (x: number) => Math.round(x * 100) / 100

/**
 * The role of a text column, from its heading and its clues. Rules are tried
 * in order and the first that holds decides — the order is part of the rule.
 */
export function textColumnRole(name: string, c: TextColumnClues): RoleDecision {
  if (c.count === 0) return { role: 'empty', roleBasis: { rule: 'no-values' } }
  const distinctRatio = c.distinct / c.count

  // Before numbers, whose shape `2024.4.1` also has.
  if (c.date >= 0.9) {
    return { role: 'measure', roleBasis: { rule: 'date-shape', share: share(c.date) } }
  }
  // Type inference leaves these as text: one `-` or `（8）` in the column does it.
  if (c.number >= 0.9) {
    return { role: 'numeric-text', roleBasis: { rule: 'number-shape', share: share(c.number) } }
  }
  // Before distinctness: a phone number repeats on every row of its facility.
  if (c.url >= 0.8) {
    return { role: 'identifier', roleBasis: { rule: 'url-shape', share: share(c.url) } }
  }
  if (c.phone >= 0.8) {
    return { role: 'identifier', roleBasis: { rule: 'phone-shape', share: share(c.phone) } }
  }

  // Length alone also catches long names; prose has punctuation or the shape of a sentence.
  if (c.avgLength >= 20 && c.ascii < 0.5 && (c.punctuation >= 0.1 || c.prose >= 0.3)) {
    return { role: 'free-text', roleBasis: { rule: 'long-prose' } }
  }
  if (c.punctuation >= 0.3) {
    return { role: 'free-text', roleBasis: { rule: 'punctuation', share: share(c.punctuation) } }
  }
  const freeHint = FREE_TEXT_HINT.exec(name)
  if (freeHint && c.avgLength >= 6) {
    return { role: 'free-text', roleBasis: { rule: 'name-hint', hint: freeHint[0] } }
  }
  if (c.prose >= 0.5 && distinctRatio >= 0.5 && c.avgLength >= 8) {
    return { role: 'free-text', roleBasis: { rule: 'prose', share: share(c.prose) } }
  }

  // Digits are what tell a code from a word: `A001` is one, `France` is a name.
  if (c.ascii >= 0.95 && c.digit >= 0.9 && distinctRatio >= 0.9) {
    return { role: 'identifier', roleBasis: { rule: 'distinct-code', share: share(distinctRatio) } }
  }
  if (c.ascii >= 0.95 && c.minLength === c.maxLength && c.digits >= 0.9 && distinctRatio >= 0.5) {
    return { role: 'identifier', roleBasis: { rule: 'fixed-width-code' } }
  }
  const idHint = IDENTIFIER_HINT.exec(name)
  if (idHint && c.ascii >= 0.9) {
    return { role: 'identifier', roleBasis: { rule: 'name-hint', hint: idHint[0] } }
  }

  // After the codes, which say more: coordinates, house numbers, amounts with
  // units — what is mostly digits names nothing to search by.
  if (c.digitChars >= 0.5 && distinctRatio >= 0.5) {
    return { role: 'identifier', roleBasis: { rule: 'mostly-digits', share: share(c.digitChars) } }
  }
  // In any language: a facility is the same name in Japanese and in English.
  if (distinctRatio >= 0.5 && c.distinct >= 30) {
    return { role: 'name', roleBasis: { rule: 'distinct-values', share: share(distinctRatio) } }
  }
  return { role: 'category', roleBasis: { rule: 'other' } }
}

/** Whether a role's values are listed in the profile (ADR-063 §決定 2). */
export function listsValues(role: ColumnRole): boolean {
  return role === 'name' || role === 'category'
}
