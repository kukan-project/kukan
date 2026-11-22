import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretJson } from '@/pipeline/interpret/table/json'
import type { ResourceColumn } from '@kukan/shared'
import type { SettledReading } from '@/pipeline/interpret/table/settled-types'

/** Settled column types read onto a JSON table (Versioning ii-c §8.3). */
describe('interpretJson — settled types', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-settled-json-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** `value` as JSON, or as the JSON text given where a literal would lose digits. */
  function interpret(value: unknown, reading: SettledReading) {
    const jsonPath = join(dir, 'in.json')
    writeFileSync(jsonPath, typeof value === 'string' ? value : JSON.stringify(value))
    return interpretJson(jsonPath, join(dir, 'out.parquet'), undefined, reading)
  }

  const column = (columns: ResourceColumn[], name: string) => columns.find((c) => c.name === name)!

  /** One column of the written preview, as DuckDB reads it back. */
  async function preview(name: string): Promise<unknown[]> {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    try {
      const reader = await conn.runAndReadAll(
        `SELECT "${name}"::VARCHAR AS v FROM read_parquet('${join(dir, 'out.parquet')}')`
      )
      return (reader.getRowObjectsJson() as { v: unknown }[]).map((r) => r.v)
    } finally {
      conn.disconnectSync()
      instance.closeSync()
    }
  }

  it('reads a number field settled as text, every digit of an integer kept', async () => {
    const { schema } = await interpret('[{"code": 7}, {"code": 12345678901234567891}]', {
      types: { code: 'string' },
    })
    expect(column(schema.columns, 'code')).toMatchObject({ type: 'string', settled: true })
    expect(await preview('code')).toEqual(['7', '12345678901234567891'])
  })

  it('reads a nested field by its flattened name, unquoted where it is a string', async () => {
    const { schema } = await interpret(
      [{ contact: { n: '1,234' } }, { contact: { n: 'unknown' } }, { contact: { n: 5 } }],
      { types: { contact_n: 'integer' } }
    )
    expect(schema.rowCount).toBe(3)
    expect(column(schema.columns, 'contact_n')).toMatchObject({
      type: 'integer',
      settled: true,
      castFailures: 1,
      castFailureSamples: [{ row: 2, value: 'unknown' }],
    })
    expect(await preview('contact_n')).toEqual(['1234', null, '5'])
  })

  it('reads a date field in the format most of its values take', async () => {
    const { schema } = await interpret([{ d: '31/12/2026' }, { d: '30/11/2026' }], {
      types: { d: 'date' },
    })
    expect(column(schema.columns, 'd')).toMatchObject({ type: 'date', dateFormat: '%d/%m/%Y' })
    expect(await preview('d')).toEqual(['2026-12-31', '2026-11-30'])
  })

  it("settles a feature's id and a Point's coordinates, outside the properties", async () => {
    const { schema } = await interpret(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 1,
            properties: { name: 'a' },
            geometry: { type: 'Point', coordinates: [135.5, 34.25] },
          },
        ],
      },
      { types: { id: 'string', geometry_lat: 'decimal' } }
    )
    expect(column(schema.columns, 'id')).toMatchObject({ type: 'string', settled: true })
    expect(column(schema.columns, 'geometry_lat')).toMatchObject({
      type: 'decimal',
      inferredType: 'float',
      decimalPrecision: 4,
      decimalScale: 2,
    })
    expect(await preview('id')).toEqual(['1'])
    expect(await preview('geometry_lat')).toEqual(['34.25'])
  })

  it('names a settled field the file does not have', async () => {
    const { schema } = await interpret([{ a: 1 }], { types: { gone: 'integer' } })
    expect(schema.missingSettled).toEqual(['gone'])
    expect(column(schema.columns, 'a').type).toBe('integer')
  })
})
