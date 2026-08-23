import { describe, it, expect } from 'vitest'
import { csvRecordLabels, dialectOf, RFC4180_DIALECT } from '../csv-records'

// Each case pins a numbering DuckDB was measured to produce (reject_errors.line
// under the sniffed dialect); csv.ts stores that dialect on the schema so the
// gutter can count the same way.
describe('csvRecordLabels', () => {
  it('numbers a plain file line by line', () => {
    expect(csvRecordLabels(['a,b', '1,2', '3,4'], RFC4180_DIALECT)).toEqual(['1', '2', '3'])
  })

  it('counts blank lines, as the reader does', () => {
    expect(csvRecordLabels(['a,b', '', '1,2'], RFC4180_DIALECT)).toEqual(['1', '2', '3'])
  })

  it('folds a quoted newline into one record and blanks its continuation', () => {
    expect(csvRecordLabels(['a,b', '"x', 'y",2', '3,4'], RFC4180_DIALECT)).toEqual([
      '1',
      '2',
      '',
      '3',
    ])
  })

  it('reads a doubled quote as staying inside the field', () => {
    expect(csvRecordLabels(['a,b', '"x""y",2', '3,4'], RFC4180_DIALECT)).toEqual(['1', '2', '3'])
  })

  it('reads a quote inside an unquoted field as a character, not an opening', () => {
    // Measured: DuckDB rejects `tail` as record 4 — the inch mark in `5"6` is
    // data, and the quoted newline after it still folds. A walk that opens on
    // any quote drifts here and the note's number lands on nothing.
    const lines = ['a,b', '5"6,2', '"x', 'y",3', 'tail']
    expect(csvRecordLabels(lines, { delimiter: ',', quote: '"', escape: null })).toEqual([
      '1',
      '2',
      '3',
      '',
      '4',
    ])
  })

  it('returns to the unquoted walk after a field closes', () => {
    // Junk after the closing quote, then a quoted newline in the next field:
    // the close must not strand the walk inside the record.
    const lines = ['a,b', '"x"y,"p', 'q"', '1,2']
    expect(csvRecordLabels(lines, RFC4180_DIALECT)).toEqual(['1', '2', '', '3'])
  })

  it('reads a backslash-escaped quote under that dialect', () => {
    const lines = ['a,b', '"x\\"y",2', '3,4']
    expect(csvRecordLabels(lines, { delimiter: ',', quote: '"', escape: '\\' })).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  it('counts under a single-quote dialect, ignoring double quotes', () => {
    const lines = ["'x", "y',2", '3,4']
    expect(csvRecordLabels(lines, { delimiter: ',', quote: "'", escape: "'" })).toEqual([
      '1',
      '',
      '2',
    ])
  })

  it('numbers every line when the file has no quoting', () => {
    // The stray inch mark that makes DuckDB sniff no quote at all. `(empty)` is
    // the sniffer's own sentinel for the same absence.
    const lines = ['a,b', 'size 5"6,2', '3,4']
    expect(csvRecordLabels(lines, { delimiter: ',', quote: null, escape: null })).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(csvRecordLabels(lines, { delimiter: ',', quote: '(empty)', escape: '(empty)' })).toEqual(
      ['1', '2', '3']
    )
    expect(csvRecordLabels(lines, null)).toEqual(['1', '2', '3'])
  })
})

describe('dialectOf', () => {
  const dialect = { delimiter: ',', quote: "'", escape: "'" }

  it('prefers the stored dialect', () => {
    expect(dialectOf({ dialect, droppedLines: [3] })).toBe(dialect)
  })

  it('assumes RFC 4180 for dropped lines stored before the dialect was kept', () => {
    expect(dialectOf({ droppedLines: [3] })).toBe(RFC4180_DIALECT)
  })

  it('answers null when there is no number to land on', () => {
    expect(dialectOf({})).toBeNull()
    expect(dialectOf(null)).toBeNull()
  })
})
