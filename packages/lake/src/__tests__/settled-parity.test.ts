/**
 * The settled rules read the same on the server's DuckDB and the browser's.
 *
 * The worker reads a version with them on @duckdb/node-api; the dashboard runs
 * them on DuckDB-WASM to say, as a type is chosen, what that type would make of
 * the column. An estimate that disagrees with the reading it estimates is worse
 * than none, and the two engines are separate builds on separate release
 * trains — so each case runs on both, and the notes, the failures and every
 * converted value must match.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SettledTypeSpec } from '@kukan/shared'
import { settledExpression, settledFailures, settledMarks, type SettledRelation } from '../settled'
import { sqlLiteral } from '../sql'

type Rows = (sql: string) => Promise<Record<string, unknown>[]>

interface Engine {
  rows: Rows
  close(): Promise<void>
}

async function nodeEngine(): Promise<Engine> {
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  return {
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS(),
    close: async () => {
      conn.disconnectSync()
      instance.closeSync()
    },
  }
}

/** What the web serves the browser's DuckDB (scripts/fetch-duckdb-extensions.mjs) */
const SERVED_EXTENSIONS = JSON.parse(
  readFileSync(
    new URL('../../../../apps/web/vendor/duckdb-extensions/manifest.json', import.meta.url),
    'utf8'
  )
) as { duckdb: string; extensions: Record<string, string> }

async function wasmEngine(): Promise<Engine> {
  const require = createRequire(import.meta.url)
  const duckdb =
    require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs') as typeof import('@duckdb/duckdb-wasm/blocking')
  const wasm = (name: string) => require.resolve(`@duckdb/duckdb-wasm/dist/${name}`)
  const db = await duckdb.createDuckDB(
    {
      base: { mainModule: wasm('duckdb-base.wasm'), mainWorker: '' },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  )
  await db.instantiate()
  const conn = db.connect()
  return {
    rows: async (sql) =>
      conn
        .query(sql)
        .toArray()
        .map((row) => ({ ...row.toJSON() })),
    close: async () => {
      conn.close()
      await db.reset()
    },
  }
}

/** A value as both engines can be compared on: bigints as numbers, the rest as is. */
function plain(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value
}

interface Case {
  name: string
  spec: SettledTypeSpec
  values: (string | null)[]
}

const CASES: Case[] = [
  {
    name: 'integer',
    spec: { type: 'integer' },
    values: [
      '1',
      ' 42 ',
      '-7',
      '+3',
      '1,234,567',
      '1.5',
      '- ',
      '+ ',
      '1,23',
      'abc',
      '',
      null,
      '9223372036854775808',
      '-',
      '－',
      '…',
      '***',
      'x',
      '―',
      'ｘ',
      '...',
      'n/a',
      ':',
      '(X)',
      '[c]',
    ],
  },
  {
    name: 'float',
    spec: { type: 'float' },
    values: ['1.5', '-0.25', '1e3', '1,234.5', 'NaN', 'inf', '.5', '1.2.3', '- ', ''],
  },
  {
    name: 'boolean',
    spec: { type: 'boolean' },
    values: ['true', 'FALSE', 't', 'f', '1', '0', 'yes', 'はい', ''],
  },
  {
    name: 'decimal',
    spec: { type: 'decimal' },
    values: ['1.5', '0.125', '-12345.6', '007', '1,234.50', '1e3', '.5', '1.2.3', ''],
  },
  {
    name: 'decimal in exponent notation',
    spec: { type: 'decimal' },
    values: [
      '1e3',
      '2.5e-3',
      '1.5E+2',
      '-.5e1',
      '025e-1',
      '1e003',
      '2.5e-004',
      '1.5e-40',
      '1e99',
      'e5',
      '1.5',
    ],
  },
  {
    name: 'decimal past 38 digits',
    spec: { type: 'decimal' },
    values: [
      '1',
      '123456789012345678901234567890123456789',
      '0.1234567890123456789012345678901234567890',
    ],
  },
  {
    name: 'date with a format',
    spec: { type: 'date', format: '%d/%m/%Y' },
    values: ['21/11/2026', '1/2/2026', '2026/11/21', '31/02/2026', '21/11/26', ''],
  },
  {
    name: 'date, its format decided',
    spec: { type: 'date' },
    values: ['2026/11/21', '2026/1/2', '2026-11-21', 'R8.11.21', '26/11/21', ''],
  },
  {
    name: 'date whose day and month cannot be told',
    spec: { type: 'date' },
    values: ['01/02/2026', '03/04/2026', '05/06/2026'],
  },
  {
    name: 'date the candidates agree on',
    spec: { type: 'date' },
    values: ['01/01/2026', '02/02/2026'],
  },
  {
    name: 'timestamp, its format decided',
    spec: { type: 'timestamp' },
    values: ['2026/11/21 09:05:00', '2026/11/21 09:05:00.25', '2026/11/21 9:05', '2026/11/21', ''],
  },
  {
    name: 'timestamp in ISO 8601',
    spec: { type: 'timestamp' },
    values: [
      '2026-11-21T09:05:00',
      '2026-11-21T09:05:00Z',
      '2026-11-21T18:05:00+09:00',
      '2026-11-21 09:05',
      '2026-11-21T09:05:00.5+0900',
      'bad',
    ],
  },
]

/** What a case reads to on one engine: the note, the failures, and each value converted. */
async function read(rows: Rows, c: Case) {
  const from = `(SELECT * FROM (VALUES ${c.values
    .map((v, i) => `(${i}, ${v === null ? 'NULL' : sqlLiteral(v)})`)
    .join(', ')}) AS t(r, v))`
  const rel: SettledRelation = { rows, from, row: 'r' }
  const { expr, note } = await settledExpression(rel, 'v', c.spec, undefined, false)
  if (expr === null) return { note }
  const failures = await settledFailures(rel, 'v', expr)
  const marks = await settledMarks(rel, 'v', expr)
  const converted = await rows(`SELECT (${expr})::VARCHAR AS x FROM ${from} ORDER BY r`)
  return { note, failures, marks, values: converted.map((row) => plain(row.x)) }
}

describe('the settled rules on the server and in the browser', () => {
  let server: Engine
  let browser: Engine

  beforeAll(async () => {
    ;[server, browser] = await Promise.all([nodeEngine(), wasmEngine()])
  })

  afterAll(async () => {
    await Promise.all([server?.close(), browser?.close()])
  })

  it('runs the same DuckDB', async () => {
    // The rest compares what the two make of the rules; this is why they can
    // be expected to agree. Upgrade one and this says to upgrade the other.
    const [[a], [b]] = await Promise.all([
      server.rows('SELECT version() AS v'),
      browser.rows('SELECT version() AS v'),
    ])
    expect(b.v).toBe(a.v)
  })

  it.each(CASES)('reads $name the same', async (c) => {
    const [a, b] = await Promise.all([read(server.rows, c), read(browser.rows, c)])
    expect(b).toEqual(a)
  })

  // After the cases, which load what the rules need: the browser loads its
  // extensions from what the web serves (apps/web/vendor/duckdb-extensions),
  // built for its DuckDB and nothing else, or a rule fails on the page alone
  it('needs only the extensions the web serves, built for its DuckDB', async () => {
    const [{ v }] = await browser.rows('SELECT version() AS v')
    expect(SERVED_EXTENSIONS.duckdb).toBe(v)
    const loaded = await browser.rows(
      "SELECT extension_name AS name FROM duckdb_extensions() WHERE loaded AND install_mode IS DISTINCT FROM 'STATICALLY_LINKED'"
    )
    for (const { name } of loaded) {
      expect(Object.keys(SERVED_EXTENSIONS.extensions), String(name)).toContain(name)
    }
  })
})
