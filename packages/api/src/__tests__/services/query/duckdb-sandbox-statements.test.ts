import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { unlink } from 'node:fs/promises'
import { ValidationError } from '@kukan/shared'
import { writeParquet } from '../../test-helpers/parquet'
import {
  PIVOT_IN_LIST_MESSAGE,
  runSandboxedQuery,
  type SandboxLimits,
} from '../../../services/query/duckdb-sandbox'
import { READ_ONLY_MESSAGE, SINGLE_STATEMENT_MESSAGE } from '../../../services/query/sql-guard'

// The guard can be switched off so the sandbox's own checks are what is tested: a
// lexer gap in the guard must not let a second statement or a write run.
const guard = vi.hoisted(() => ({ on: true }))
vi.mock('../../../services/query/sql-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/query/sql-guard')>()
  return {
    ...actual,
    assertReadOnlySql: (sql: string) => {
      if (guard.on) actual.assertReadOnlySql(sql)
    },
  }
})

const LIMITS: SandboxLimits = {
  maxRows: 10,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  memoryLimitMb: 256,
  threads: 2,
}

// Bypasses of the guard's lexer before it read nested block comments and continued
// E strings; DuckDB runs the DELETE in each.
const NESTED_COMMENT_DELETE =
  'WITH x AS (SELECT 1) /* /* */ $$ */ DELETE FROM data RETURNING id -- $$'
const CONTINUED_E_STRING_DELETE =
  "WITH x AS (SELECT E'a'\n'\\'') DELETE FROM data RETURNING id -- '"

// Writes DuckDB 2 types as a SELECT, the first two behind what the guard's lexer
// read otherwise than DuckDB: a comment ended by a carriage return, and a
// continued E string closed at its quote.
const CTE_WRITES = [
  'WITH x AS -- c\r (DELETE FROM data RETURNING *) SELECT count(*) AS n FROM x',
  "WITH s AS (SELECT e'a'\n'\\' AS v), y AS (DELETE FROM data RETURNING *) SELECT count(*) AS n FROM y --'",
  'WITH x AS (DELETE FROM data RETURNING *) SELECT count(*) AS n FROM x',
  'WITH x AS (INSERT INTO data SELECT * FROM data RETURNING *) SELECT count(*) AS n FROM x',
  'WITH x AS (UPDATE data SET v = 0 RETURNING *) SELECT count(*) AS n FROM x',
  "WITH x AS (COPY data TO (current_setting('temp_directory') || '/x.csv')) SELECT * FROM x",
]

describe('runSandboxedQuery statement checks', () => {
  let fixture: string

  beforeAll(async () => {
    fixture = await writeParquet("SELECT i AS id, 'c' || (i % 2) AS cat, i AS v FROM range(3) t(i)")
  })

  afterAll(async () => {
    await unlink(fixture).catch(() => {})
  })

  describe('without the guard', () => {
    beforeAll(() => {
      guard.on = false
    })
    afterAll(() => {
      guard.on = true
    })

    it('refuses two statements before running the first', async () => {
      // Were the first statement run, the second would read the table it made.
      const run = runSandboxedQuery(
        fixture,
        'CREATE TABLE evil AS SELECT 42 AS pwned; SELECT * FROM evil',
        LIMITS
      )
      await expect(run).rejects.toThrow(ValidationError)
      await expect(run).rejects.toThrow(SINGLE_STATEMENT_MESSAGE)
    })

    it('refuses a single statement that is not a SELECT', async () => {
      await expect(runSandboxedQuery(fixture, NESTED_COMMENT_DELETE, LIMITS)).rejects.toThrow(
        READ_ONLY_MESSAGE
      )
    })

    it('refuses a continued E string, which DuckDB 2.0 no longer parses', async () => {
      await expect(runSandboxedQuery(fixture, CONTINUED_E_STRING_DELETE, LIMITS)).rejects.toThrow(
        ValidationError
      )
    })

    it.each(CTE_WRITES)('refuses a write in a CTE, typed a SELECT: %j', async (sql) => {
      await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(READ_ONLY_MESSAGE)
    })

    it.each([
      [
        'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r',
        3,
      ],
      ['SELECT id FROM data UNION ALL SELECT id FROM data', 6],
      ['FROM data SELECT id', 3],
      ['VALUES (1), (2)', 2],
      [
        'WITH x AS MATERIALIZED (SELECT * FROM data) SELECT * FROM x WHERE id IN (SELECT id FROM x)',
        3,
      ],
      ["SELECT * FROM (PIVOT data ON cat IN ('c0', 'c1') USING sum(v) GROUP BY id)", 3],
      ['SELECT \'WITH x AS (DELETE FROM data RETURNING *)\' AS "DELETE_QUERY_NODE"', 1],
    ])('still runs a statement that only reads: %j', async (sql, rows) => {
      expect((await runSandboxedQuery(fixture, sql, LIMITS)).rowCount).toBe(rows)
    })

    it('still runs a single statement', async () => {
      const res = await runSandboxedQuery(fixture, 'SELECT count(*) AS c FROM data;', LIMITS)
      expect(res.rows[0].c).toBe(3)
    })

    it('reports a statement DuckDB cannot parse as a failed query', async () => {
      await expect(runSandboxedQuery(fixture, 'SELECT FROM WHERE', LIMITS)).rejects.toThrow(
        /^Query failed: /
      )
    })
  })

  describe('with the guard', () => {
    it.each([
      NESTED_COMMENT_DELETE,
      CONTINUED_E_STRING_DELETE,
      'SELECT 1 /* /* */ $$ */; CREATE TABLE evil AS SELECT 1 -- $$',
      "SELECT E'a'\n'\\'; CREATE TABLE evil AS SELECT 1 -- '",
      'SELECT 1 -- c\r; CREATE TABLE evil AS SELECT 1',
      ...CTE_WRITES,
    ])('fails closed on %j', async (sql) => {
      await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(ValidationError)
    })

    it('says a PIVOT needs its IN list, which DuckDB otherwise runs as two statements', async () => {
      for (const sql of [
        'SELECT * FROM (PIVOT data ON cat USING sum(v))',
        'WITH p AS (PIVOT data ON cat USING sum(v)) SELECT * FROM p',
      ]) {
        await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(PIVOT_IN_LIST_MESSAGE)
      }
    })

    it('runs a PIVOT with its IN list', async () => {
      const res = await runSandboxedQuery(
        fixture,
        "SELECT * FROM (PIVOT data ON cat IN ('c0', 'c1') USING sum(v) GROUP BY id) ORDER BY id",
        LIMITS
      )
      expect(res.rowCount).toBe(3)
      expect(res.columns).toEqual(['id', 'c0', 'c1'])
    })
  })
})
