import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { TableProfileLine } from '@kukan/shared'
import { DuckDBInstance } from '@duckdb/node-api'
import {
  flatten,
  interpretJson,
  jsonStartsWithObject,
  structFields,
} from '@/pipeline/interpret/table/json'

const MAX_OBJECT = 16 * 1024 * 1024

/** JSON records as DuckDB reads them (ADR-063 extension), over a real interpretation. */
describe('interpretJson', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-json-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function interpret(json: string, withProfile = true) {
    const jsonPath = join(dir, 'in.json')
    writeFileSync(jsonPath, json)
    const parquetPath = join(dir, 'out.parquet')
    const profilePath = withProfile ? join(dir, 'profile.ndjson.zst') : undefined
    const result = await interpretJson(jsonPath, parquetPath, profilePath, MAX_OBJECT)
    return { ...result, parquetPath, profilePath }
  }

  const profileLines = (path: string): TableProfileLine[] =>
    zstdDecompressSync(readFileSync(path))
      .toString('utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TableProfileLine)

  it('reads a top-level array of objects as a table, nested objects as path-named columns', async () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      name: `施設${i}`,
      kind: i % 2 ? '公園' : '広場',
      contact: { phone: `03-0000-${String(i).padStart(4, '0')}`, address: { city: '港区' } },
      links: [{ uri: `https://example.jp/${i}` }],
      note: i % 3 ? null : '駐車場は、正面にあります。',
    }))
    const { schema, reason, parquetPath, profile } = await interpret(JSON.stringify(records))

    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(12)
    expect(schema.columns.map((c) => c.name)).toEqual([
      'name',
      'kind',
      'contact_phone',
      'contact_address_city',
      'links',
      'note',
    ])
    expect(schema.geometryTypes).toBeUndefined()
    expect(existsSync(parquetPath)).toBe(true)
    // The array is JSON text in its column, not a column per element
    expect(schema.columns.find((c) => c.name === 'links')).toMatchObject({
      type: 'string',
      distinctCount: 12,
    })
    // Roles by the same rules as a CSV's (ADR-063 §決定 1), one per column
    const roles = profile?.columns.map((c) => c.role)
    expect(roles).toHaveLength(6)
    expect(roles?.[5]).toBe('free-text')
    expect(roles?.[1]).toBe('category')
  })

  it('reads the one array under a key, and leaves what sits beside it', async () => {
    const file = {
      title: '施設一覧',
      meta: { updated: '2026-10-01' },
      dataset: [
        { id: 'A1', name: '東公園', visitors: 120 },
        { id: 'A2', name: '西公園', visitors: 80 },
      ],
    }
    const { schema, reason } = await interpret(JSON.stringify(file))

    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(2)
    expect(schema.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'string'],
      ['name', 'string'],
      ['visitors', 'integer'],
    ])
  })

  it('reads a FeatureCollection by its properties, keeping the shapes out and their kinds', async () => {
    const features = [
      {
        type: 'Feature',
        properties: { 名称: '区役所', 所在地: '芝公園一丁目' },
        geometry: { type: 'Point', coordinates: [139.75, 35.65] },
      },
      {
        type: 'Feature',
        properties: { 名称: '公園', 所在地: '芝公園四丁目' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [139.74, 35.65],
              [139.75, 35.65],
              [139.75, 35.66],
              [139.74, 35.65],
            ],
          ],
        },
      },
    ]
    const { schema, reason, profilePath } = await interpret(
      JSON.stringify({ type: 'FeatureCollection', name: 'facilities', features })
    )

    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(2)
    expect(schema.columns.map((c) => c.name)).toEqual([
      '名称',
      '所在地',
      'geometry_lon',
      'geometry_lat',
    ])
    expect(schema.geometryTypes).toEqual(['Point', 'Polygon'])
    // The Point's place is two numbers; the Polygon's row has none
    expect(schema.columns[2]).toMatchObject({
      type: 'float',
      nullCount: 1,
      stats: { min: 139.75, max: 139.75 },
    })
    expect(schema.columns[3]).toMatchObject({ type: 'float', stats: { min: 35.65, max: 35.65 } })
    // No coordinate reaches the index
    const texts = profileLines(profilePath!).map((l) => l.text)
    expect(texts).toContain('区役所')
    expect(texts.some((t) => t.includes('139.7'))).toBe(false)
  })

  it('reads every Point of a FeatureCollection as its longitude and latitude', async () => {
    const features = [139.7, 139.8].map((lon, i) => ({
      type: 'Feature',
      properties: { id: `P${i}` },
      geometry: { type: 'Point', coordinates: [lon, 35.6 + i] },
    }))
    const { schema } = await interpret(JSON.stringify({ type: 'FeatureCollection', features }))
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'geometry_lon', 'geometry_lat'])
    expect(schema.columns[1]).toMatchObject({ nullCount: 0, stats: { min: 139.7, max: 139.8 } })
    expect(schema.columns[2]).toMatchObject({ nullCount: 0, stats: { min: 35.6, max: 36.6 } })
  })

  it("keeps a feature's id where the file gives one, beside a property of the same name", async () => {
    const features = [1, 2].map((n) => ({
      type: 'Feature',
      id: n,
      properties: { id: `P${n}`, name: `校区${n}` },
      geometry: null,
    }))
    const { schema } = await interpret(JSON.stringify({ type: 'FeatureCollection', features }))
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'id_2'])
    // Every feature has one, all different: a key candidate
    expect(schema.columns[2]).toMatchObject({ type: 'integer', unique: true })
  })

  it('makes no id column where no feature has one', async () => {
    const features = [{ type: 'Feature', properties: { name: 'a' }, geometry: null }]
    const { schema } = await interpret(JSON.stringify({ type: 'FeatureCollection', features }))
    expect(schema.columns.map((c) => c.name)).toEqual(['name'])
  })

  it('gives a FeatureCollection of lines no place columns', async () => {
    const features = [
      {
        type: 'Feature',
        properties: { name: '道路' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.7, 35.6],
            [139.8, 35.7],
          ],
        },
      },
    ]
    const { schema } = await interpret(JSON.stringify({ type: 'FeatureCollection', features }))
    expect(schema.columns.map((c) => c.name)).toEqual(['name'])
    expect(schema.geometryTypes).toEqual(['LineString'])
  })

  it('refuses a FeatureCollection whose features carry no properties', async () => {
    const { reason } = await interpret(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }],
      })
    )
    expect(reason).toBe('not-records')
  })

  it('reads objects one per line as the records they are', async () => {
    const lines = [
      { id: 1, tags: [{ k: 'a' }, { k: 'b' }] },
      { id: 2, tags: [{ k: 'c' }] },
    ]
    const { schema, reason } = await interpret(lines.map((l) => JSON.stringify(l)).join('\n'))

    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(2)
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'tags'])
  })

  it('refuses a file that is one object past the size one value may have as too large, not as no record', async () => {
    // The reader buffers a value at least 16MB whatever it is told, so only a
    // file past that reaches the refusal
    const jsonPath = join(dir, 'big.json')
    writeFileSync(jsonPath, JSON.stringify({ dataset: [{ id: 1, text: 'x'.repeat(17_000_000) }] }))
    const { reason } = await interpretJson(
      jsonPath,
      join(dir, 'big.parquet'),
      undefined,
      16 * 1024 * 1024
    )
    expect(reason).toBe('too-large')
  })

  it('reads the geometry type as text where one feature typed it otherwise', async () => {
    const features = [
      {
        type: 'Feature',
        properties: { id: 'a' },
        geometry: { type: 'Point', coordinates: [139.7, 35.6] },
      },
      { type: 'Feature', properties: { id: 'b' }, geometry: { type: 1, coordinates: [] } },
    ]
    const { schema } = await interpret(JSON.stringify({ type: 'FeatureCollection', features }))
    expect(schema.geometryTypes).toEqual(['1', 'Point'])
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'geometry_lon', 'geometry_lat'])
    expect(schema.columns[1]).toMatchObject({ nullCount: 1 })
  })

  it('keeps every field of a record that has a key named like the table it is read into', async () => {
    const { schema, reason } = await interpret(JSON.stringify([{ src: { x: 1 }, id: 10 }]))
    expect(reason).toBeUndefined()
    expect(schema.columns.map((c) => c.name)).toEqual(['src_x', 'id'])
  })

  it("reads a key or a type that first appears past the reader's default sample", async () => {
    const records = Array.from({ length: 21_000 }, (_, i) =>
      i < 20_500 ? { id: i } : { id: i, extra: `x${i}` }
    )
    const { schema, reason } = await interpret(JSON.stringify(records), false)
    expect(reason).toBeUndefined()
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'extra'])
    expect(schema.columns[1]).toMatchObject({ nullCount: 20_500 })
  })

  it('reads a record of more keys than the reader would make a map of', async () => {
    const record = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, i]))
    const { schema, reason } = await interpret(JSON.stringify([record]), false)
    expect(reason).toBeUndefined()
    expect(schema.columns).toHaveLength(201)
  })

  it('reads records whose one key is json, and refuses an array of bare values', async () => {
    const records = await interpret(JSON.stringify([{ json: 'hello' }, { json: 'world' }]))
    expect(records.reason).toBeUndefined()
    expect(records.schema.columns.map((c) => c.name)).toEqual(['json'])
    expect((await interpret(JSON.stringify(['hello', 'world']))).reason).toBe('not-records')
  })

  it('settles an empty array as no columns, and a file of null as no records, without throwing', async () => {
    expect((await interpret('[]')).reason).toBe('no-columns')
    expect((await interpret('null')).reason).toBe('not-records')
  })

  it('reads objects one per line whose one key is json', async () => {
    const { schema, reason } = await interpret('{"json":"hello"}\n{"json":"world"}')
    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(2)
  })

  it('finds the object behind more whitespace than any head would hold', async () => {
    const { schema, reason } = await interpret(
      ' '.repeat(1025) + JSON.stringify({ records: [{ id: 1 }, { id: 2 }] })
    )
    expect(reason).toBeUndefined()
    expect(schema.rowCount).toBe(2)
    expect(schema.columns.map((c) => c.name)).toEqual(['id'])
  })

  it('keeps every digit of an integer too large for a double, so two IDs stay two', async () => {
    const big =
      '[{"id":123456789012345678901,"n":{"k":123456789012345678902}},' +
      '{"id":123456789012345678902,"n":{"k":1}}]'
    const { schema, reason, parquetPath } = await interpret(big, false)
    expect(reason).toBeUndefined()
    expect(schema.columns.find((c) => c.name === 'id')).toMatchObject({
      type: 'string',
      distinctCount: 2,
      unique: true,
    })
    const conn = await (await DuckDBInstance.create(':memory:')).connect()
    const rows = (
      await conn.runAndReadAll(`SELECT id, n_k FROM read_parquet('${parquetPath}') ORDER BY id`)
    ).getRows()
    expect(rows).toEqual([
      ['123456789012345678901', '123456789012345678902'],
      ['123456789012345678902', '1'],
    ])
  })

  it('keeps every digit under a key and in a FeatureCollection too', async () => {
    const underKey = await interpret(
      '{"dataset":[{"id":123456789012345678901},{"id":123456789012345678902}]}',
      false
    )
    expect(underKey.schema.columns[0]).toMatchObject({ type: 'string', distinctCount: 2 })
    const features = await interpret(
      '{"type":"FeatureCollection","features":[' +
        '{"type":"Feature","id":123456789012345678901,"properties":{"p":123456789012345678901},"geometry":null},' +
        '{"type":"Feature","id":123456789012345678902,"properties":{"p":123456789012345678902},"geometry":null}]}',
      false
    )
    expect(features.schema.columns.map((c) => [c.name, c.type, c.distinctCount])).toEqual([
      ['p', 'string', 2],
      ['id', 'string', 2],
    ])
  })

  it('refuses keys that differ only in case, nested or at the top, and keeps a key that only looks renamed', async () => {
    expect((await interpret('[{"properties":{"id":1,"ID":2}}]')).reason).toBe('not-records')
    expect((await interpret('[{"id":1,"ID":2}]')).reason).toBe('not-records')
    // Where re-reading a large integer would have lost the renamed key's values
    expect((await interpret('[{"id":1,"ID":2,"big":123456789012345678901}]')).reason).toBe(
      'not-records'
    )
    const legit = await interpret('[{"id":1,"id_1":2}]', false)
    expect(legit.reason).toBeUndefined()
    expect(legit.schema.columns.map((c) => c.name)).toEqual(['id', 'id_1'])
    // Named like a renaming, but the file's own keys
    const ownKey = await interpret('[{"ID":1,"id_1":2}]', false)
    expect(ownKey.reason).toBeUndefined()
    expect(ownKey.schema.columns.map((c) => c.name)).toEqual(['ID', 'id_1'])
  })

  it('refuses an object that is not a list of records', async () => {
    expect((await interpret(JSON.stringify({ a: 1, b: { c: 'x' } }))).reason).toBe('not-records')
    expect((await interpret(JSON.stringify({ x: [{ a: 1 }], y: [{ b: 2 }] }))).reason).toBe(
      'not-records'
    )
  })

  it('refuses an array of anything but objects, and a file that is not JSON', async () => {
    expect((await interpret('[1, 2, 3]')).reason).toBe('not-records')
    expect((await interpret('["a", "b"]')).reason).toBe('not-records')
    expect((await interpret('{"a": [1, 2')).reason).toBe('not-records')
  })

  it('keeps a value the reader could give no one type as its text', async () => {
    const records = [
      { id: 1, extra: 'plain' },
      { id: 2, extra: 42 },
      { id: 3, extra: { nested: true } },
    ]
    const { schema, reason, parquetPath } = await interpret(JSON.stringify(records), false)

    expect(reason).toBeUndefined()
    expect(schema.columns.find((c) => c.name === 'extra')).toMatchObject({ type: 'string' })
    // A bare string comes out as itself, not as the quoted JSON of it
    const conn = await (await DuckDBInstance.create(':memory:')).connect()
    const values = (
      await conn.runAndReadAll(`SELECT extra FROM read_parquet('${parquetPath}') ORDER BY id`)
    )
      .getRows()
      .map((r) => r[0])
    expect(values).toEqual(['plain', '42', '{"nested":true}'])
  })

  it('tells a file that is one object from an array by its first byte', async () => {
    const head = (text: string) => jsonStartsWithObject(Readable.from([Buffer.from(text)]))
    expect(await head('\uFEFF \n {"a": []}')).toBe(true)
    expect(await head('\n[{"a": 1}]')).toBe(false)
    // Past any one chunk of whitespace
    expect(await jsonStartsWithObject(Readable.from([' '.repeat(2048), '\t\n', '{"a": 1}']))).toBe(
      true
    )
    expect(await head('   ')).toBe(false)
  })
})

describe('structFields', () => {
  it('splits a nested struct type, unquoting the names the reader quoted', () => {
    expect(
      structFields('STRUCT("type" VARCHAR, properties STRUCT(a BIGINT, "b, c" STRUCT(d VARCHAR)))')
    ).toEqual([
      { name: 'type', type: 'VARCHAR' },
      { name: 'properties', type: 'STRUCT(a BIGINT, "b, c" STRUCT(d VARCHAR))' },
    ])
    expect(structFields('VARCHAR')).toBeNull()
    expect(structFields('STRUCT(a VARCHAR)[]')).toBeNull()
  })
})

describe('flatten', () => {
  it('names a column by its path joined with _, so the name stays an OData identifier', () => {
    const leaves = flatten([
      { name: 'a.b', type: 'VARCHAR' },
      { name: 'a', type: 'STRUCT(b BIGINT)' },
      { name: 'tags', type: 'VARCHAR[]' },
    ])
    expect(leaves.map((l) => l.name)).toEqual(['a.b', 'a_b', 'tags'])
    expect(leaves[1].sql).toBe('r."a"."b"')
    expect(leaves[2].sql).toContain('to_json(')
  })

  it('suffixes a path that spells another, moving on past a name a field already spells', () => {
    const leaves = flatten([
      { name: 'a_b', type: 'VARCHAR' },
      { name: 'a', type: 'STRUCT(b BIGINT)' },
      { name: 'a_b_2', type: 'VARCHAR' },
    ])
    expect(leaves.map((l) => l.name)).toEqual(['a_b', 'a_b_3', 'a_b_2'])
  })
})
