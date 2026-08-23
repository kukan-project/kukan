import type { ReactNode } from 'react'
import type { ResourceColumn, ResourceColumnType } from '@kukan/shared'

/**
 * One colour for "this column is the key", shared by every table that says it:
 * the picker's sample, the public preview and the analysis mode. The header is
 * a tint of the brand colour, not of `muted`, because it sits on muted
 * surfaces (sticky headers, row hovers) where a muted mark would vanish.
 */
export const KEY_HEADER_CLASS = 'bg-primary/15 text-foreground'
export const KEY_CELL_CLASS = 'bg-primary/10'

/** A number rendered the plain way — the only shape the decimal padding fits. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/

function isNumericType(type: ResourceColumnType | undefined): boolean {
  return type === 'integer' || type === 'float'
}

function fractionDigits(text: string): number {
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/**
 * How a page of rows lays its numeric columns out: which columns right-align,
 * and per float column the widest fraction on the page — the padding target
 * for {@link decimalAligned}. One helper for both table modes, so the same
 * Parquet cannot align two ways.
 */
export function numericLayout<Row>(
  columns: string[],
  schemaColumns: ResourceColumn[] | null | undefined,
  rows: Row[],
  textOf: (row: Row, col: string) => string
): { isNumeric: (col: string) => boolean; maxFractions: Map<string, number> } {
  const types = new Map((schemaColumns ?? []).map((c) => [c.name, c.type]))
  const maxFractions = new Map<string, number>()
  for (const col of columns) {
    if (types.get(col) !== 'float') continue
    let max = 0
    for (const row of rows) {
      const text = textOf(row, col)
      if (PLAIN_DECIMAL.test(text)) max = Math.max(max, fractionDigits(text))
    }
    maxFractions.set(col, max)
  }
  return { isNumeric: (col) => isNumericType(types.get(col)), maxFractions }
}

/** The one data-cell class both table modes render. */
export function dataCellClass(numeric: boolean, key: boolean): string {
  return `whitespace-nowrap px-4 py-2${numeric ? ' text-right tabular-nums' : ''}${
    key ? ` ${KEY_CELL_CLASS}` : ''
  }`
}

/**
 * The cell text, padded out to `maxFrac` fraction digits with invisible zeros.
 *
 * HTML never implemented aligning a column on its decimal point, so this is the
 * standard substitute: with `tabular-nums` every digit is the same width, and a
 * right-aligned column whose cells all *occupy* the same fraction width lines
 * up on the point. The padding is rendered but invisible, so copying a cell
 * still copies the value as it is.
 */
export function decimalAligned(text: string, maxFrac: number): ReactNode {
  if (maxFrac === 0 || !PLAIN_DECIMAL.test(text)) return text
  const pad = maxFrac - fractionDigits(text)
  if (pad === 0) return text
  return (
    <>
      {text}
      <span className="invisible">
        {text.includes('.') ? '0'.repeat(pad) : `.${'0'.repeat(pad)}`}
      </span>
    </>
  )
}
