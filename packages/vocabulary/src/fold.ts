/**
 * KUKAN column vocabulary — the closed lists a scheme picks from (ADR-073 §決定 2)
 */

import type { CheckDigitRule, Folding, Transform } from './types'

/**
 * The digit a code ends with, from the digits before it, by each rule.
 *
 * `mod11-weights-6-2`: weights 6, 5, 4, 3, 2 over five digits, and the digit is
 * eleven less the remainder, the last place of it — Japan's local government
 * codes (JIS X 0402), and whatever else is built the same way.
 */
const CHECK_DIGITS: Record<CheckDigitRule, (body: string) => string | null> = {
  'mod11-weights-6-2': (body) => {
    if (!/^\d{5}$/.test(body)) return null
    const total = [...body].reduce((sum, d, i) => sum + Number(d) * (6 - i), 0)
    return String((11 - (total % 11)) % 10)
  },
}

export function checkDigit(rule: CheckDigitRule, body: string): string | null {
  return CHECK_DIGITS[rule](body)
}

/** Whether a code's last digit is the one its rule gives. */
export function hasValidCheckDigit(rule: CheckDigitRule, code: string): boolean {
  return code.length > 1 && checkDigit(rule, code.slice(0, -1)) === code.slice(-1)
}

const FOLDINGS: Record<Folding, (s: string) => string> = {
  nfkc: (s) => s.normalize('NFKC'),
  // `\s` takes the ideographic space too
  'strip-spaces': (s) => s.replace(/\s+/g, ''),
  lowercase: (s) => s.toLowerCase(),
  uppercase: (s) => s.toUpperCase(),
  // 竜ケ崎 and 竜ヶ崎 are one name: the small ケ is written either way
  'small-kana-ke': (s) => s.replace(/[ヶヵ]/g, (c) => (c === 'ヶ' ? 'ケ' : 'カ')),
}

/** A value as a scheme compares it: trimmed, then each of its foldings in order. */
export function fold(foldings: Folding[], value: string): string {
  return foldings.reduce((s, f) => FOLDINGS[f](s), value.trim())
}

/**
 * Each transform, and whether a value written that way carries the digit that
 * checks it — what lets a column of such values be inferred on its own.
 */
export const TRANSFORMS: Record<
  Transform,
  {
    apply: (rule: CheckDigitRule | undefined, value: string) => string | null
    carriesCheckDigit: boolean
  }
> = {
  'append-check-digit': {
    apply: (rule, value) => {
      const digit = rule === undefined ? null : checkDigit(rule, value)
      return digit === null ? null : `${value}${digit}`
    },
    carriesCheckDigit: false,
  },
}
