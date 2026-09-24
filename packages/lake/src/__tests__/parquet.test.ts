import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRowGroupRows } from '../parquet'

let dir: string
let conn: DuckDBConnection

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kukan-parquet-'))
  conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run('SET threads = 1')
})

afterAll(() => {
  conn.disconnectSync()
  rmSync(dir, { recursive: true, force: true })
})

async function write(name: string, rows: number, groupSize: number): Promise<string> {
  const path = join(dir, `${name}.parquet`)
  await conn.run(
    `COPY (SELECT i FROM range(${rows}) t(i)) TO '${path}' (FORMAT parquet, ROW_GROUP_SIZE ${groupSize})`
  )
  return path
}

/** A connection that answers the footer query with the groups given. */
function footer(groups: number[]) {
  const last = groups.length - 1
  const body = groups.slice(0, last)
  return {
    runAndReadAll: async () => ({
      getRowObjectsJson: () => [
        {
          groups: String(groups.length),
          widest: groups.length ? String(Math.max(...groups)) : null,
          shapes: String(new Set(body).size),
          size: body.length ? String(Math.max(...body)) : null,
        },
      ],
    }),
  }
}

describe('readRowGroupRows', () => {
  it('answers the size every group but the last shares', async () => {
    expect(await readRowGroupRows(conn, await write('uniform', 10_000, 4096))).toBe(4096)
  })

  it('answers a single group as its own size', async () => {
    expect(await readRowGroupRows(conn, await write('single', 100, 4096))).toBe(100)
  })

  it('answers null for a file with no groups', async () => {
    expect(await readRowGroupRows(conn, await write('empty', 0, 4096))).toBeNull()
  })

  it('answers null when the groups do not share a size', async () => {
    // The parallel writer can emit a group larger than the size asked for. The
    // largest group would then put a reader's page cuts where no boundary is,
    // so such a file is unknown rather than mismeasured.
    expect(await readRowGroupRows(footer([4096, 4096, 5395, 4096, 3789]), 'x')).toBeNull()
  })

  it('does not let a short last group disagree', async () => {
    expect(await readRowGroupRows(footer([4096, 4096, 1808]), 'x')).toBe(4096)
  })
})
