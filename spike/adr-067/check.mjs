// Does a DuckLake catalog kept as a per-resource SQLite file behave like the
// one KUKAN keeps in PostgreSQL today (ADR-067 decision 7)? Each check below is
// one item of that list. The catalog is a local file; DATA_PATH is MinIO from
// compose.yml, so the data side matches production.
//
//   node spike/adr-067/check.mjs [--catalog sqlite|duckdb] [--only 1,4] [--versions 50]
//
// `--catalog duckdb` runs the same checks against a DuckDB-file catalog, the
// runner-up (option D), so items 4 and 7 can be compared side by side.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { URL } from 'node:url'

const root = new URL('../../', import.meta.url).pathname
const require = createRequire(`${root}apps/worker/package.json`)
const { DuckDBInstance } = require('@duckdb/node-api')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const CATALOG = arg('catalog', 'sqlite')
const ONLY = arg('only', '1,2,3,4,5,6,7').split(',').map(Number)
const VERSIONS = Number(arg('versions', 50))
const ROWS = Number(arg('rows', 10_000))
const CHANGED_PER_VERSION = Number(arg('changed', 20))

const env = Object.fromEntries(
  readFileSync(`${root}.env`, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [
      l.slice(0, l.indexOf('=')),
      l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, ''),
    ])
)
const run = `${Date.now()}`
const work = mkdtempSync(join(tmpdir(), 'adr-067-'))
const bucket = `s3://${env.S3_BUCKET}/spike-adr-067/${run}`

/** The layout decision 1 proposes: a generation holds the catalog and, apart from it, the data. */
const layout = (resource, generation) => ({
  catalog: join(work, `${resource}.${generation}.${CATALOG === 'sqlite' ? 'sqlite' : 'ducklake'}`),
  prefix: `${bucket}/lake/${resource}/${generation}/`,
  dataPath: `${bucket}/lake/${resource}/${generation}/data/`,
})

async function session(extensions = ['httpfs', 'aws', CATALOG === 'sqlite' ? 'sqlite' : null]) {
  const opts = process.env.DUCKDB_EXTENSION_DIRECTORY
    ? {
        extension_directory: process.env.DUCKDB_EXTENSION_DIRECTORY,
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
      }
    : {}
  const conn = await (await DuckDBInstance.create(':memory:', opts)).connect()
  for (const e of [...extensions.filter(Boolean), 'ducklake']) await conn.run(`LOAD ${e}`)
  const endpoint = env.S3_ENDPOINT.replace(/^https?:\/\//, '')
  await conn.run(`CREATE SECRET (TYPE s3, KEY_ID '${env.S3_ACCESS_KEY}', SECRET '${env.S3_SECRET_KEY}',
    ENDPOINT '${endpoint}', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')`)
  return conn
}

const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson()
const timed = async (fn) => {
  const t = performance.now()
  const value = await fn()
  return { ms: Math.round(performance.now() - t), value }
}

async function attach(conn, { catalog, dataPath }, readOnly = false) {
  const scheme = CATALOG === 'sqlite' ? 'ducklake:sqlite:' : 'ducklake:'
  await conn.run(
    `ATTACH '${scheme}${catalog}' AS lake (DATA_PATH '${dataPath}'${readOnly ? ', READ_ONLY' : ''})`
  )
}

/** Version n of a synthetic table: ROWS rows keyed by `id`, a few changed each version. */
async function writeVersion(conn, n) {
  const path = join(work, `v${n}.parquet`)
  await conn.run(`COPY (
    SELECT i AS id, 'name ' || i AS name,
      CASE WHEN i % ${ROWS / CHANGED_PER_VERSION} = ${n} % ${ROWS / CHANGED_PER_VERSION} THEN i * ${n} ELSE i END AS amount
    FROM range(${ROWS}) t(i)
    WHERE NOT (${n} > 1 AND i = ${n})   -- one row removed per version
  ) TO '${path}' (FORMAT parquet)`)
  return path
}

/** The keyed load as `keyed-load.ts` writes it: upsert, then delete, one transaction = one snapshot. */
async function keyedIngest(conn, source) {
  await conn.run('BEGIN')
  await conn.run(`MERGE INTO lake.t AS t USING read_parquet('${source}') AS s ON t.id = s.id
    WHEN MATCHED AND (t.name IS DISTINCT FROM s.name OR t.amount IS DISTINCT FROM s.amount)
      THEN UPDATE SET name = s.name, amount = s.amount
    WHEN NOT MATCHED THEN INSERT (id, name, amount) VALUES (s.id, s.name, s.amount)`)
  await conn.run(`MERGE INTO lake.t AS t USING read_parquet('${source}') AS s ON t.id = s.id
    WHEN NOT MATCHED BY SOURCE THEN DELETE`)
  await conn.run('COMMIT')
}

const latestSnapshot = async (conn) =>
  Number((await rows(conn, `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')`))[0].id)

/** Creates a catalog with inlining off and ingests versions 1..n; returns each version's snapshot. */
async function build(conn, where, versions) {
  await attach(conn, where)
  await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
  const snapshots = []
  for (let n = 1; n <= versions; n++) {
    const source = await writeVersion(conn, n)
    if (n === 1) await conn.run(`CREATE TABLE lake.t AS SELECT * FROM read_parquet('${source}')`)
    else await keyedIngest(conn, source)
    snapshots.push(await latestSnapshot(conn))
  }
  return snapshots
}

/** Runs a child that keeps committing versions into `where`, and SIGKILLs it after delayMs. */
function killWriterAfter(where, delayMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        new URL(import.meta.url).pathname,
        '--catalog',
        CATALOG,
        '--crash-writer',
        where.catalog,
        where.dataPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    let committed = 0
    child.stdout.on(
      'data',
      (b) =>
        (committed += String(b)
          .split('\n')
          .filter((l) => l === 'commit').length)
    )
    setTimeout(() => child.kill('SIGKILL'), delayMs)
    child.on('exit', () => resolve(committed))
  })
}

/** What a reader finds after a crash: SQLite's own check, and whether DuckLake still opens it. */
async function inspect(where) {
  const leftovers = readdirSync(work).filter((f) =>
    f.startsWith(where.catalog.split('/').at(-1) + '-')
  )
  let integrity = null
  if (CATALOG === 'sqlite') {
    // Read without DuckDB at all — the point of option E.
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(where.catalog, { readOnly: true })
    integrity = raw.prepare('PRAGMA integrity_check').get()
    raw.close()
  }
  try {
    const conn = await session()
    await attach(conn, where, true)
    const latest = await latestSnapshot(conn)
    const count = await rows(conn, 'SELECT count(*) AS n FROM lake.t')
    return { leftovers, integrity, latest, rows: count[0].n }
  } catch (e) {
    return { leftovers, integrity, attachError: String(e.message ?? e) }
  }
}

const checks = {
  /** 1. Full replace, keyed MERGE, time travel, expire, cleanup and compaction behave as on the other catalog. */
  async 1() {
    const conn = await session()
    const where = layout('r1', 'g1')
    const snapshots = await build(conn, where, 5)
    // Full replace, the ii-a path: DELETE + INSERT in one transaction.
    await conn.run('BEGIN')
    await conn.run('DELETE FROM lake.t')
    await conn.run(
      `INSERT INTO lake.t SELECT * FROM read_parquet('${await writeVersion(conn, 6)}')`
    )
    await conn.run('COMMIT')
    snapshots.push(await latestSnapshot(conn))
    // The diff reads both ends by snapshot, as `diffVersions` does.
    const [a, b] = [snapshots[1], snapshots[4]]
    const diff = await rows(
      conn,
      `SELECT count(*) AS changed FROM (
         SELECT * FROM lake.t AT (VERSION => ${a}) EXCEPT SELECT * FROM lake.t AT (VERSION => ${b}))`
    )
    const filesBefore = await rows(
      conn,
      `SELECT count(*) AS n FROM ducklake_list_files('lake', 't')`
    )
    await conn.run(`CALL ducklake_merge_adjacent_files('lake')`)
    const keep = new Set([snapshots.at(-1)])
    const expire = snapshots.filter((s) => !keep.has(s))
    await conn.run(`CALL ducklake_expire_snapshots('lake', versions => [${expire.join(', ')}])`)
    const cleaned = await rows(conn, `CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)
    const filesAfter = await rows(
      conn,
      `SELECT count(*) AS n FROM ducklake_list_files('lake', 't')`
    )
    const remaining = await rows(conn, `SELECT count(*) AS n FROM glob('${where.dataPath}**')`)
    return {
      snapshots,
      diff: diff[0],
      filesBefore: filesBefore[0],
      filesAfter: filesAfter[0],
      cleaned: cleaned.length,
      objectsLeft: remaining[0],
    }
  },

  /** 2. `data_inlining_row_limit = 0` survives DETACH and re-ATTACH, and a small insert writes a file. */
  async 2() {
    const where = layout('r2', 'g1')
    const writer = await session()
    await build(writer, where, 1)
    await writer.run('DETACH lake')
    const reader = await session()
    await attach(reader, where)
    const option = await rows(
      reader,
      `SELECT option_name, value, scope FROM ducklake_options('lake') WHERE option_name = 'data_inlining_row_limit'`
    )
    await reader.run(`INSERT INTO lake.t VALUES (-1, 'one row', 0)`)
    const inlined = await rows(reader, `SELECT count(*) AS n FROM ducklake_list_files('lake', 't')`)
    return { option, filesAfterOneRowInsert: inlined[0] }
  },

  /** 3. No -wal / -journal next to the catalog after DETACH; a writer killed mid-commit leaves a consistent file. */
  async 3() {
    const where = layout('r3', 'g1')
    const conn = await session()
    await build(conn, where, 3)
    await conn.run('DETACH lake')
    const siblings = readdirSync(work).filter((f) => f.startsWith('r3.g1.'))
    // DuckLake writes the catalog at COMMIT, so a kill has to land inside one:
    // a child commits versions back to back, and is killed at staggered times.
    const crashes = []
    for (const delayMs of [800, 1300, 1900, 2600, 3400]) {
      const committed = await killWriterAfter(where, delayMs)
      crashes.push({ delayMs, committed, ...(await inspect(where)) })
    }
    return { siblings, crashes }
  },

  /** 4. Catalog size with VERSIONS versions (~10 files each before compaction), and ATTACH time. */
  async 4() {
    const where = layout('r4', 'g1')
    const conn = await session()
    const { ms: buildMs } = await timed(() => build(conn, where, VERSIONS))
    const files = await rows(conn, `SELECT count(*) AS n FROM ducklake_list_files('lake', 't')`)
    await conn.run('DETACH lake')
    const bytes = statSync(where.catalog).size
    const attachMs = []
    for (let i = 0; i < 5; i++) {
      const fresh = await session()
      attachMs.push((await timed(() => attach(fresh, where, true))).ms)
    }
    return { catalog: CATALOG, versions: VERSIONS, files: files[0], bytes, buildMs, attachMs }
  },

  /** 5. The sqlite extension loads from a pinned DUCKDB_EXTENSION_DIRECTORY with autoloading off. */
  async 5() {
    const dir = process.env.DUCKDB_EXTENSION_DIRECTORY
    if (!dir)
      return {
        skipped:
          'set DUCKDB_EXTENSION_DIRECTORY to a directory holding httpfs, aws, sqlite, ducklake',
      }
    const conn = await session()
    const loaded = await rows(
      conn,
      `SELECT extension_name, extension_version, install_path FROM duckdb_extensions() WHERE loaded`
    )
    const version = await rows(conn, `SELECT version() AS v`)
    return { dir, version: version[0], loaded }
  },

  /** 6. delete_orphaned_files stays inside DATA_PATH; and where today's single catalog puts files. */
  async 6() {
    const where = layout('r6', 'g1')
    const conn = await session()
    await build(conn, where, 2)
    // A stand-in for the catalog file next to DATA_PATH, and a real orphan inside it.
    await conn.run(
      `COPY (SELECT 1 AS x) TO '${where.prefix}catalog.sentinel.parquet' (FORMAT parquet)`
    )
    await conn.run(`COPY (SELECT 1 AS x) TO '${where.dataPath}orphan.parquet' (FORMAT parquet)`)
    await conn.run(
      `CALL ducklake_delete_orphaned_files('lake', older_than => now() + INTERVAL 1 MINUTE)`
    )
    const left = await rows(conn, `SELECT file FROM glob('${where.prefix}**') ORDER BY file`)
    return {
      sentinelKept: left.some((r) => r.file.endsWith('catalog.sentinel.parquet')),
      orphanRemoved: !left.some((r) => r.file.endsWith('orphan.parquet')),
      // The hierarchy DuckLake writes under DATA_PATH — the same one today's
      // `lake/` holds, which the migration (decision 6) deletes by hand.
      layout: left.map((r) => r.file.slice(where.dataPath.length)),
    }
  },

  /** 7. Rebuild after a purge: re-ingest VERSIONS - 1 versions into a fresh generation. */
  /** 8. Large diffs: ingest time per version, diff time far and near, catalog size. Use --rows/--changed. */
  async 8() {
    const where = layout(`r8-${ROWS}-${CHANGED_PER_VERSION}`, 'g1')
    const conn = await session()
    await attach(conn, where)
    await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
    const ingestMs = []
    const snapshots = []
    for (let n = 1; n <= VERSIONS; n++) {
      const source = await writeVersion(conn, n)
      const { ms } = await timed(() =>
        n === 1
          ? conn.run(`CREATE TABLE lake.t AS SELECT * FROM read_parquet('${source}')`)
          : keyedIngest(conn, source)
      )
      ingestMs.push(ms)
      snapshots.push(await latestSnapshot(conn))
    }
    const files = await rows(conn, `SELECT count(*) AS n FROM ducklake_list_files('lake', 't')`)
    await conn.run('DETACH lake')
    const bytes = statSync(where.catalog).size

    // As the web would: a fresh read-only session per diff, ends matched on the key.
    const diff = async (a, b) => {
      const reader = await session()
      await attach(reader, where, true)
      const { ms, value } = await timed(() =>
        rows(
          reader,
          `SELECT count(*) AS changed
           FROM (SELECT * FROM lake.t AT (VERSION => ${a})) o
           FULL JOIN (SELECT * FROM lake.t AT (VERSION => ${b})) n ON o.id = n.id
           WHERE o.id IS NULL OR n.id IS NULL
              OR o.name IS DISTINCT FROM n.name OR o.amount IS DISTINCT FROM n.amount`
        )
      )
      return { ms, changed: value[0].changed }
    }
    const median = async (a, b) => {
      const runs = [await diff(a, b), await diff(a, b), await diff(a, b)]
      runs.sort((x, y) => x.ms - y.ms)
      return runs[1]
    }
    const avg = (xs) => Math.round(xs.reduce((t, x) => t + x, 0) / xs.length)
    return {
      catalog: CATALOG,
      rows: ROWS,
      changedPerVersion: CHANGED_PER_VERSION,
      versions: VERSIONS,
      ingestMs: { first: ingestMs[0], avg: avg(ingestMs.slice(1)), last: ingestMs.at(-1) },
      files: files[0],
      bytes,
      diffFar: await median(snapshots[0], snapshots.at(-1)),
      diffNear: await median(snapshots.at(-2), snapshots.at(-1)),
    }
  },

  /** 9. A catalog re-ATTACHed with a different DATA_PATH: which path do reads and new writes use? */
  async 9() {
    const first = layout('r9', 'g1')
    const conn = await session()
    await build(conn, first, 2)
    await conn.run('DETACH lake')
    const moved = { ...first, dataPath: `${bucket}/elsewhere/r9/` }
    const other = await session()
    let refused = null
    try {
      await attach(other, moved)
    } catch (e) {
      refused = String(e.message ?? e).split('\n')[0]
    }
    // What the error offers: point the catalog at the new place explicitly.
    const scheme = CATALOG === 'sqlite' ? 'ducklake:sqlite:' : 'ducklake:'
    await other.run(
      `ATTACH '${scheme}${moved.catalog}' AS lake (DATA_PATH '${moved.dataPath}', OVERRIDE_DATA_PATH true)`
    )
    const option = await rows(
      other,
      `SELECT option_name, value FROM ducklake_options('lake') WHERE option_name = 'data_path'`
    )
    let readError = null
    let count = null
    try {
      count = (await rows(other, 'SELECT count(*) AS n FROM lake.t'))[0].n
    } catch (e) {
      readError = String(e.message ?? e)
    }
    await keyedIngest(other, await writeVersion(other, 3))
    const files = await rows(other, `SELECT data_file FROM ducklake_list_files('lake', 't')`)
    return {
      refused,
      option,
      count,
      readError,
      newFilesUnder: [
        ...new Set(
          files.map((f) => (f.data_file.includes('/elsewhere/') ? 'elsewhere' : 'original'))
        ),
      ],
    }
  },

  async 7() {
    const conn = await session()
    const purged = Math.ceil(VERSIONS / 2)
    const fresh = layout('r7', 'g2')
    await attach(conn, fresh)
    await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)
    const { ms } = await timed(async () => {
      let first = true
      for (let n = 1; n <= VERSIONS; n++) {
        if (n === purged) continue
        const source = await writeVersion(conn, n)
        if (first) await conn.run(`CREATE TABLE lake.t AS SELECT * FROM read_parquet('${source}')`)
        else await keyedIngest(conn, source)
        first = false
      }
    })
    const snapshots = await rows(conn, `SELECT count(*) AS n FROM ducklake_snapshots('lake')`)
    return { versions: VERSIONS - 1, purged, ms, snapshots: snapshots[0] }
  },
}

if (process.argv.includes('--crash-writer')) {
  // The child of item 3: commits keyed versions into an existing catalog until killed.
  const [catalog, dataPath] = process.argv.slice(process.argv.indexOf('--crash-writer') + 1)
  const conn = await session()
  await attach(conn, { catalog, dataPath })
  for (let n = 100; ; n++) {
    await keyedIngest(conn, await writeVersion(conn, n))
    process.stdout.write('commit\n')
  }
}

/** Progress for the person running it. */
const say = (...parts) => process.stdout.write(parts.join(' ') + '\n')

const results = { catalog: CATALOG, work, bucket, items: {} }
for (const n of ONLY) {
  try {
    results.items[n] = await checks[n]()
  } catch (e) {
    results.items[n] = { error: String(e.message ?? e) }
  }
  say(n, JSON.stringify(results.items[n]))
}
const out = new URL(`results-${CATALOG}.json`, import.meta.url).pathname
writeFileSync(out, JSON.stringify(results, null, 2))
say(`wrote ${out}${existsSync(work) ? `; local catalogs in ${work}` : ''}`)
