/**
 * The rule that separates a publisher's sign-off from a truncated row.
 *
 * A table of lines rather than a table of CSV files: the rule is about the line,
 * and the cases that are about DuckDB refusing one live in
 * `interpret-typing.test.ts`. This is what makes the two constants cheap to
 * retune — they are a trade-off taken deliberately, and a sweep over real lines
 * costs nothing here.
 */
import { describe, it, expect } from 'vitest'
import { looksLikeSignOff } from '../pipeline/interpret/csv-sign-off'

/** The scan's answer for an ordinary comma-separated file. */
const signOff = (text: string, columns: number) =>
  looksLikeSignOff(text, { delimiter: ',', quote: '"', escape: '"' }, columns)

describe('looksLikeSignOff', () => {
  it('reads two values in a table of thirty-one columns as a sign-off', () => {
    // The file #449 was reported on, quoted as it really is.
    expect(signOff('"港区施設情報 区役所・総合支所","Ver20260804"', 31)).toBe(true)
  })

  it('reads the same two values in a table of three columns as a row', () => {
    // Losing one of three fields is the ordinary way a row breaks.
    expect(signOff('20021001,88900', 3)).toBe(false)
  })

  it('does not hold a broken value against a line', () => {
    // The refused lines took no part in deciding the column types, so a cast
    // that fails is evidence of nothing. Only the shape is read.
    expect(signOff('2002/10/01,N/A', 3)).toBe(false)
    expect(signOff('2002/10/01,N/A', 31)).toBe(true)
  })

  it('counts a quoted cell holding the delimiter once', () => {
    // Split on the delimiter this is four values, which in a six-column table
    // is a row; parsed it is two, which is a sign-off.
    expect(signOff('"出典: 港区, 統計課, 2026","Ver1"', 6)).toBe(true)
  })

  it('takes the quote character the scan settled on', () => {
    const single = { delimiter: ',', quote: "'", escape: "'" }
    const none = { delimiter: ',', quote: null, escape: null }
    expect(looksLikeSignOff("'a,b,c,d','e'", single, 10)).toBe(true)
    // The same line where the file has no quoting: five values, not two, and a
    // literal double quote is not a quote either.
    expect(looksLikeSignOff("'a,b,c,d','e'", none, 10)).toBe(false)
    expect(looksLikeSignOff('"a,b,c,d","e"', none, 10)).toBe(false)
  })

  it('measures a tab-separated line with tabs', () => {
    const tabs = { delimiter: '\t', quote: '"', escape: '"' }
    expect(looksLikeSignOff('出典: 港区\t2026', tabs, 10)).toBe(true)
    // Every value on one side of a comma, so by tabs this is a single cell.
    expect(looksLikeSignOff('a,b,c,d,e,f,g,h', tabs, 10)).toBe(true)
  })

  it('takes the escape character the scan settled on', () => {
    // A file that escapes its quotes with a backslash. Read with the parser's
    // default — the quote character — the value ends at `\\"` and the rest is
    // unparseable, so the line reads as a row and the resource loses its table.
    const backslash = { delimiter: ',', quote: '"', escape: '\\' }
    expect(looksLikeSignOff('"出典: 港区 \\"庁舎\\"","Ver1"', backslash, 6)).toBe(true)
    expect(
      looksLikeSignOff('"出典: 港区 \\"庁舎\\"","Ver1"', { ...backslash, escape: '"' }, 6)
    ).toBe(false)
  })

  it('refuses a line the parser could not read', () => {
    // An unterminated quote parses to something, and what it parses to says
    // nothing about how many values the publisher wrote.
    expect(signOff('"a,b', 31)).toBe(false)
  })

  it('refuses a line that turns out to be more than one', () => {
    expect(signOff('a\nb', 31)).toBe(false)
  })

  it('ignores the terminators the line was stored with, on both ends', () => {
    // DuckDB stores a refused line with the end of the record before it, and
    // with any blank line between — the file #449 was reported on arrives as
    // `\n\r\n"港区施設情報…"`. Read as given, that is three rows and no line.
    expect(signOff('出典: 港区,2026\r\n', 10)).toBe(true)
    expect(signOff('\n\r\n"港区施設情報 区役所・総合支所","Ver20260804"', 31)).toBe(true)
  })

  it('needs both halves of the rule', () => {
    // Four values is past what a sign-off holds, however wide the table…
    expect(signOff('a,b,c,d', 79)).toBe(false)
    // …and three values two columns short of the table is a row, however few.
    expect(signOff('a,b,c', 5)).toBe(false)
    expect(signOff('a,b,c', 6)).toBe(true)
  })
})
