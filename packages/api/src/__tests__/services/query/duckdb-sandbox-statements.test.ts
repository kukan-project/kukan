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

    it.each([NESTED_COMMENT_DELETE, CONTINUED_E_STRING_DELETE])(
      'refuses a single statement that is not a SELECT: %j',
      async (sql) => {
        await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(READ_ONLY_MESSAGE)
      }
    )

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
      "SELECT E'a'\n'\\''; CREATE TABLE evil AS SELECT 1 -- '",
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
