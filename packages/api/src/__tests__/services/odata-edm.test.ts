import { describe, it, expect } from 'vitest'
import type { ResourceColumn, ResourceSchema } from '@kukan/shared'
import {
  buildMetadataXml,
  buildModel,
  edmRefusal,
  isEdmIdentifier,
  pickKeyName,
  toEdmValue,
} from '../../services/odata/edm'

function schemaOf(names: string[]): ResourceSchema {
  return {
    columns: names.map((name) => ({ name, type: 'string', nullable: true, nullCount: 0 })),
    rowCount: 3,
  }
}

describe('isEdmIdentifier', () => {
  it('accepts Japanese headings, which are letter runs', () => {
    expect(isEdmIdentifier('人口')).toBe(true)
    expect(isEdmIdentifier('市区町村コード')).toBe(true)
  })

  it('accepts ASCII names that start with a letter or underscore', () => {
    expect(isEdmIdentifier('name')).toBe(true)
    expect(isEdmIdentifier('_x1')).toBe(true)
  })

  // The shapes ADR-055 names as the common case in Japanese open data.
  it.each(['人口（人）', '面積 (km²)', 'H31.4.1現在', '1月', '', 'a-b'])('refuses %j', (name) => {
    expect(isEdmIdentifier(name)).toBe(false)
  })

  it('refuses a name past the 128-character limit', () => {
    expect(isEdmIdentifier('a'.repeat(128))).toBe(true)
    expect(isEdmIdentifier('a'.repeat(129))).toBe(false)
  })
})

describe('edmRefusal', () => {
  it('passes a schema whose names are all identifiers', () => {
    expect(edmRefusal(schemaOf(['id', '人口']))).toBeNull()
  })

  it('names the headings that need normalization', () => {
    expect(edmRefusal(schemaOf(['id', '人口（人）', '面積 (km²)']))).toEqual({
      reason: 'unsupported-columns',
      columns: ['人口（人）', '面積 (km²)'],
    })
  })

  it('names every one of them, not a sample', () => {
    const many = Array.from({ length: 9 }, (_, i) => `列 ${i}`)
    expect(edmRefusal(schemaOf(['id', ...many]))?.columns).toHaveLength(9)
  })

  it('names the heading that repeats, once', () => {
    expect(edmRefusal(schemaOf(['id', 'id', 'id', 'name']))).toEqual({
      reason: 'duplicate-columns',
      columns: ['id'],
    })
  })
})

describe('pickKeyName', () => {
  it('uses RowId when the table has no such column', () => {
    expect(pickKeyName(schemaOf(['id']).columns)).toBe('RowId')
  })

  it('steps aside for a table that already has one', () => {
    expect(pickKeyName(schemaOf(['RowId']).columns)).toBe('RowId_')
    expect(pickKeyName(schemaOf(['RowId', 'RowId_']).columns)).toBe('RowId__')
  })
})

describe('buildModel with a designated primary key', () => {
  // The counts the interpretation froze (ADR-046): three rows, three distinct
  // values, none missing — a column that identifies a row.
  const column = (over: Partial<ResourceColumn> & { name: string }): ResourceColumn => ({
    type: 'string',
    nullable: false,
    nullCount: 0,
    distinctCount: 3,
    ...over,
  })
  const schemaWith = (...columns: ResourceColumn[]): ResourceSchema => ({ columns, rowCount: 3 })

  it('uses the column the publisher named, and adds none', () => {
    const model = buildModel(schemaWith(column({ name: 'code' }), column({ name: 'name' })), [
      'code',
    ])
    expect(model.keyNames).toEqual(['code'])
    expect(model.syntheticKey).toBe(null)
  })

  it('falls back where the column does not identify a row', () => {
    // Fewer distinct values than rows: the key repeats, and a repeated key has
    // a BI tool folding rows together. The same arithmetic the key-setting
    // check uses, so the two cannot answer differently.
    const model = buildModel(schemaWith(column({ name: 'code', distinctCount: 2 })), ['code'])
    expect(model.keyNames).toEqual(['RowId'])
    expect(model.keyFallback).toBe('key-not-unique')
  })

  it('falls back for a type no key may have, and for a column that is gone', () => {
    // A float key can only be a standing one now: the key-setting API refuses
    // the type on a change (spec §6.4), so what reaches here was set before
    // that rule, or under a column that has since re-read as `float`.
    const float = buildModel(schemaWith(column({ name: 'ratio', type: 'float' })), ['ratio'])
    expect(float.keyFallback).toBe('key-float')
    const missing = buildModel(schemaWith(column({ name: 'code' })), ['gone'])
    expect(missing.keyFallback).toBe('key-missing')
    // Including a composite whose *second* column is the one that went: the
    // frozen counts stop at a combination, and a caller told "they cannot say"
    // would go on to read a column that is not there.
    const half = buildModel(schemaWith(column({ name: 'a' })), ['a', 'gone'])
    expect(half.keyFallback).toBe('key-missing')
    expect(buildModel(schemaWith(column({ name: 'code' })), null).keyFallback).toBe(
      'not-designated'
    )
  })

  it('refuses an integer key whose digits would not survive the JSON number', () => {
    // `Edm.Int64` is written as a JSON number, so 2^53 and 2^53+1 arrive as one
    // value and the rows behind them merge in the reader's table.
    const keyed = (min: string, max: string) =>
      buildModel(schemaWith(column({ name: 'id', type: 'integer', stats: { min, max } })), ['id'])
        .keyFallback

    expect(keyed('1', '9007199254740991')).toBe(null)
    expect(keyed('1', '9007199254740992')).toBe('unsafe-integers')
    expect(keyed('-9007199254740992', '1')).toBe('unsafe-integers')
    // An unknown range is not a safe one
    expect(
      buildModel(schemaWith(column({ name: 'id', type: 'integer' })), ['id']).keyFallback
    ).toBe('unsafe-integers')
  })

  it('takes a composite key the version was ingested under, and refuses one it was not', () => {
    // Per-column counts say nothing about a combination, so the answer comes
    // from the ingest that checked this version's own rows (spec §6.6).
    const schema = schemaWith(column({ name: 'a', distinctCount: 2 }), column({ name: 'b' }))
    expect(buildModel(schema, ['a', 'b'], ['a', 'b']).keyNames).toEqual(['a', 'b'])
    expect(buildModel(schema, ['a', 'b'], null).keyFallback).toBe('unverified')
    // A different key was verified: this one is unchecked against these rows
    expect(buildModel(schema, ['a', 'b'], ['b']).keyFallback).toBe('unverified')
  })

  it('refuses a key whose column holds a missing value, however it was verified', () => {
    const schema = schemaWith(column({ name: 'a', nullCount: 1 }), column({ name: 'b' }))
    expect(buildModel(schema, ['a', 'b'], ['a', 'b']).keyFallback).toBe('key-null')
  })

  it('declares the chosen column non-nullable, as a key must be', () => {
    const xml = buildMetadataXml(
      buildModel(schemaWith(column({ name: 'code', nullable: true })), ['code'])
    )
    expect(xml).toContain('<Key><PropertyRef Name="code"/></Key>')
    expect(xml).toContain('<Property Name="code" Type="Edm.String" Nullable="false"/>')
    expect(xml).not.toContain('RowId')
  })
})

describe('buildMetadataXml', () => {
  it('declares the synthetic key and one property per column', () => {
    const schema: ResourceSchema = {
      columns: [
        { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
        { name: '人口', type: 'float', nullable: true, nullCount: 1 },
        { name: 'flag', type: 'boolean', nullable: true, nullCount: 0 },
        { name: 'day', type: 'date', nullable: true, nullCount: 0 },
        { name: 'at', type: 'timestamp', nullable: true, nullCount: 0 },
      ],
      rowCount: 10,
    }
    const xml = buildMetadataXml(buildModel(schema))
    expect(xml).toContain('<Key><PropertyRef Name="RowId"/></Key>')
    expect(xml).toContain('<Property Name="RowId" Type="Edm.Int64" Nullable="false"/>')
    expect(xml).toContain('<Property Name="id" Type="Edm.Int64" Nullable="false"/>')
    expect(xml).toContain('<Property Name="人口" Type="Edm.Double" Nullable="true"/>')
    expect(xml).toContain('<Property Name="flag" Type="Edm.Boolean" Nullable="true"/>')
    expect(xml).toContain('<Property Name="day" Type="Edm.Date" Nullable="true"/>')
    expect(xml).toContain('<Property Name="at" Type="Edm.DateTimeOffset" Nullable="true"/>')
    expect(xml).toContain('<EntitySet Name="Rows" EntityType="KUKAN.Row"/>')
  })
})

describe('toEdmValue', () => {
  it('turns DuckDB’s own numeric values into JSON numbers', () => {
    // BIGINT comes over as a bigint, which JSON.stringify would throw on
    expect(toEdmValue(42n, 'integer')).toBe(42)
    expect(toEdmValue('42', 'integer')).toBe(42)
    // DECIMAL comes over as a value object, which would serialize as {}
    expect(toEdmValue({ toString: () => '1.500' }, 'float')).toBe(1.5)
    expect(toEdmValue(1.5, 'float')).toBe(1.5)
  })

  it('writes a naive timestamp as UTC, and leaves one that has a zone', () => {
    expect(toEdmValue({ toString: () => '2024-01-02 03:04:05.25' }, 'timestamp')).toBe(
      '2024-01-02T03:04:05.25Z'
    )
    expect(toEdmValue('2024-01-02 03:04:05.25', 'timestamp')).toBe('2024-01-02T03:04:05.25Z')
    expect(toEdmValue('2024-01-02T03:04:05Z', 'timestamp')).toBe('2024-01-02T03:04:05Z')
    expect(toEdmValue('2024-01-02T03:04:05+09:00', 'timestamp')).toBe('2024-01-02T03:04:05+09:00')
  })

  it('completes the hours-only offset DuckDB prints for a zoned timestamp', () => {
    // What a `TIMESTAMP WITH TIME ZONE` column actually reads back as: the
    // offset has no minutes, and `+09Z` is not a DateTimeOffset.
    expect(toEdmValue('2024-01-01 09:00:00+09', 'timestamp')).toBe('2024-01-01T09:00:00+09:00')
    expect(toEdmValue('2024-01-01 00:00:00+00', 'timestamp')).toBe('2024-01-01T00:00:00+00:00')
    expect(toEdmValue('2024-01-01 09:00:00-05', 'timestamp')).toBe('2024-01-01T09:00:00-05:00')
    expect(toEdmValue('2024-01-01 09:00:00+05:30', 'timestamp')).toBe('2024-01-01T09:00:00+05:30')
    expect(toEdmValue('2024-01-01 09:00:00.5+09', 'timestamp')).toBe('2024-01-01T09:00:00.5+09:00')
    // A date's own hyphens are not an offset.
    expect(toEdmValue('2024-01-01 09:00:00', 'timestamp')).toBe('2024-01-01T09:00:00Z')
  })

  it('spells the special doubles, which JSON would turn into null', () => {
    // `nan` / `inf` / `-inf` in a CSV are read as a DOUBLE column, so a file
    // that has them would otherwise hand a BI tool a gap under a property the
    // metadata declared non-nullable (OData JSON 4.01 §7.1).
    expect(toEdmValue(NaN, 'float')).toBe('NaN')
    expect(toEdmValue(Infinity, 'float')).toBe('INF')
    expect(toEdmValue(-Infinity, 'float')).toBe('-INF')
    expect(JSON.parse(JSON.stringify({ v: toEdmValue(NaN, 'float') })).v).toBe('NaN')
  })

  it('passes other types through, nulls included', () => {
    expect(toEdmValue(null, 'string')).toBeNull()
    expect(toEdmValue(1.5, 'float')).toBe(1.5)
    expect(toEdmValue(true, 'boolean')).toBe(true)
    expect(toEdmValue('2024-01-02', 'date')).toBe('2024-01-02')
    expect(toEdmValue({ toString: () => '2024-01-02' }, 'date')).toBe('2024-01-02')
  })
})

describe('an integer past what a JS number holds', () => {
  it('reaches the row as its own digits, not as the double it would become', () => {
    // `Number(9007199254740993n)` is …92, so a feed that converted would be
    // answering with a value the file does not hold. What a client makes of
    // the digits is its own parser's business.
    const row = (v: bigint) => JSON.stringify({ id: toEdmValue(v, 'integer') })
    expect(row(9007199254740993n)).toBe('{"id":9007199254740993}')
    expect(row(-9007199254740993n)).toBe('{"id":-9007199254740993}')
  })

  it('leaves an integer the double holds exactly as a plain number', () => {
    expect(toEdmValue(9007199254740991n, 'integer')).toBe(9007199254740991)
  })
})
