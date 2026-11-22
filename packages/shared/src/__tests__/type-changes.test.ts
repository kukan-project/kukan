import { describe, it, expect } from 'vitest'
import { typeChangesOf, typeReviewChoices, typeReviewChoicesFor } from '../type-changes'
import type { ResourceColumn, ResourceSchema } from '../pipeline-types'

const col = (name: string, type: ResourceColumn['type'], extra: Partial<ResourceColumn> = {}) =>
  ({ name, type, nullable: true, ...extra }) as ResourceColumn
const schema = (columns: ResourceColumn[], extra: Partial<ResourceSchema> = {}) =>
  ({ columns, rowCount: 10, ...extra }) as ResourceSchema

describe('typeChangesOf', () => {
  it('has nothing to review for a first version, or one read as the last', () => {
    const now = schema([col('a', 'integer'), col('b', 'string')])
    expect(typeChangesOf(now, null)).toBeNull()
    expect(typeChangesOf(now, now)).toBeNull()
  })

  it('names a column inference read as another type than the version before', () => {
    const changes = typeChangesOf(
      schema([col('a', 'string'), col('b', 'integer')]),
      schema([col('a', 'integer'), col('b', 'integer')])
    )
    expect(changes).toEqual([
      { kind: 'type', column: 'a', from: { type: 'integer' }, to: { type: 'string' } },
    ])
  })

  it('leaves out columns added or dropped, and a type moved by settling or lifting it', () => {
    expect(
      typeChangesOf(
        schema([col('new', 'string'), col('s', 'integer', { settled: true })]),
        schema([col('gone', 'string'), col('s', 'string')])
      )
    ).toBeNull()
  })

  it('names a settled decimal whose digits moved, and offers only to accept it', () => {
    const [change] = typeChangesOf(
      schema([col('d', 'decimal', { settled: true, decimalPrecision: 12, decimalScale: 3 })]),
      schema([col('d', 'decimal', { settled: true, decimalPrecision: 10, decimalScale: 2 })])
    )!
    expect(change).toEqual({
      kind: 'type',
      column: 'd',
      from: { type: 'decimal', decimalPrecision: 10, decimalScale: 2 },
      to: { type: 'decimal', decimalPrecision: 12, decimalScale: 3 },
    })
    expect(typeReviewChoices(change)).toEqual(['accept'])
  })

  it('names what a settled reading left: values not converted, a format not decided, a column not there', () => {
    const changes = typeChangesOf(
      schema(
        [
          col('n', 'integer', { settled: true, castFailures: 3 }),
          col('d', 'string', { settled: true, dateFormatUndecided: true }),
        ],
        { missingSettled: ['gone'] }
      ),
      null
    )
    expect(changes).toEqual([
      { kind: 'cast-failures', column: 'n', count: 3 },
      { kind: 'date-undecided', column: 'd' },
      { kind: 'missing', column: 'gone' },
    ])
    expect(changes!.map(typeReviewChoices)).toEqual([
      ['accept', 'lift'],
      ['accept', 'lift'],
      ['accept', 'lift'],
    ])
  })

  it('offers to settle the previous type for a type inference changed', () => {
    expect(
      typeReviewChoices({
        kind: 'type',
        column: 'a',
        from: { type: 'integer' },
        to: { type: 'string' },
      })
    ).toEqual(['accept', 'settle-previous'])
  })

  it('offers a column any choice one of its changes offers', () => {
    // Digits moved and values not converted on one settled decimal: lifting answers both
    const changes = typeChangesOf(
      schema([
        col('d', 'decimal', {
          settled: true,
          decimalPrecision: 12,
          decimalScale: 3,
          castFailures: 1,
        }),
      ]),
      schema([col('d', 'decimal', { settled: true, decimalPrecision: 10, decimalScale: 2 })])
    )!
    expect(changes.map((change) => change.kind)).toEqual(['cast-failures', 'type'])
    expect(typeReviewChoicesFor(changes, 'd')).toEqual(['accept', 'lift'])
  })

  it('does not ask again about values a review settled the previous type over', () => {
    const now = schema([col('n', 'integer', { settled: true, castFailures: 1 })])
    expect(typeChangesOf(now, null, ['n'])).toBeNull()
    expect(typeChangesOf(now, null, ['other'])).toEqual([
      { kind: 'cast-failures', column: 'n', count: 1 },
    ])
  })
})
