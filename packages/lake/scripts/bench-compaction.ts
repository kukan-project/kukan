/**
 * Compaction benchmark for ADR-043 layer 2 (spec §11-2.1).
 *
 * Produces the numbers §11-2.1 rests on: what `merge_adjacent_files` costs at a
 * given file-count threshold, and what it buys. Committed because the decision
 * is a constant — `MERGE_FILE_THRESHOLD` — and a constant with no way to
 * re-derive it is a constant nobody can revisit.
 *
 * **Run it where the reader runs, with the threads the reader gets.** What sets
 * the per-file scan cost is not the store's latency but how many range requests
 * can be in flight to hide it — which is `threads`, defaulting to the core
 * count. The same S3 bucket cost 3.11ms per file at 2 threads and 0.32ms at 16.
 * A local filesystem understates it either way, and comparing machines with
 * different core counts compares core counts.
 *
 * Cold and warm are reported separately and differ by an order — a process that
 * has already read the files pays a tenth of what the first query pays. Every
 * new version's file is cold to every process until first touched, so neither
 * column is the exceptional case.
 *
 * What transfers is the shape — scan is linear in file count, merge cannot go
 * below a floor, and byte volume takes over once files are large — not the
 * constants.
 *
 * Usage (from the repo root):
 *   pnpm bench:lake                       # local temp dir
 *   pnpm bench:lake --data s3://bucket/prefix/   # MinIO or S3, see env below
 *   pnpm bench:lake --shape wide --versions 100 --thresholds 1,25,100
 *   pnpm bench:lake --thresholds none --scan-threads 2,4,8,16,32
 *   (pnpm forwards flags as-is — do NOT add `--`, parseArgs would reject it)
 *
 * For an S3/MinIO data path: S3_ENDPOINT (MinIO only), S3_REGION, and either
 * S3_ACCESS_KEY / S3_SECRET_KEY (plus S3_SESSION_TOKEN when temporary), or
 * nothing at all — with no key it falls back to the host's credential chain,
 * which is what an EC2 instance profile provides. Writes a few hundred MB and thousands of
 * objects under the prefix, and does not clean up — use a scratch bucket.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { keyedLoadSql } from '../src/keyed-load'

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    shape: { type: 'string', default: 'light' },
    versions: { type: 'string', default: '360' },
    thresholds: { type: 'string', default: 'none,25,100,200,400' },
    base: { type: 'string' },
    // Re-measure the same worst-case scan under different `threads` settings.
    // DuckDB is a thread pool, not async I/O, so the number of range requests in
    // flight is the thread count — which is why the same bucket costs an order
    // more per file on a small machine.
    'scan-threads': { type: 'string' },
  },
})

const SHAPE = values.shape === 'wide' ? 'wide' : 'light'
const VERSIONS = Number(values.versions)
// A ~256-char pseudo-random payload, so the table reaches real size and resists
// compression — the arm that shows byte volume taking over from file count.
const WIDE_PAYLOAD = `md5(i::VARCHAR) || md5((i*7+1)::VARCHAR) || md5((i*13+2)::VARCHAR) ||
  md5((i*29+3)::VARCHAR) || md5((i*31+5)::VARCHAR) || md5((i*37+7)::VARCHAR) ||
  md5((i*41+11)::VARCHAR) || md5((i*43+13)::VARCHAR)`
const BASE = Number(values.base ?? (SHAPE === 'wide' ? 400_000 : 20_000))
const APPEND = 200
// One id in this many is corrected at each version, so a version changes about
// BASE/FIX_PERIOD rows — five at the default base, the rate the earlier shape used.
const FIX_PERIOD = 4000

interface Result {
  threshold: number | null
  merges: number
  mergeSeconds: number
  buildSeconds: number
  worstFiles: number
  coldScanMs: number
  warmScanMs: number
  megabytes: number
  byThreads: Array<{ threads: number; scanMs: number }>
}

async function run(threshold: number | null): Promise<Result> {
  const local = values.data ? undefined : mkdtempSync(join(tmpdir(), 'kukan-bench-'))
  // Each arm needs its own catalog and prefix, or the previous arm's files are
  // still there to be scanned.
  const stamp = `${SHAPE}-${threshold ?? 'none'}-${VERSIONS}`
  const dataPath = local ? `${local}/data/` : `${values.data!.replace(/\/?$/, '/')}${stamp}/`
  // Keyed by the data path as well as the arm: a catalog left in /tmp by a run
  // against another bucket refuses to attach to a new DATA_PATH, and a stale one
  // against the same path would carry the previous run's versions into this one.
  const slug = (values.data ?? 'local').replace(/[^a-zA-Z0-9]+/g, '-')
  const catalog = local
    ? `${local}/catalog.ducklake`
    : `${tmpdir()}/kukan-bench-${slug}-${stamp}.ducklake`
  if (!local) rmSync(catalog, { force: true })

  const conn: DuckDBConnection = await (await DuckDBInstance.create(':memory:')).connect()
  let secret = ''
  await conn.run(`INSTALL ducklake`)
  await conn.run(`LOAD ducklake`)
  if (!local) {
    await conn.run(`INSTALL httpfs`)
    await conn.run(`LOAD httpfs`)
    const endpoint = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT) : undefined
    // No explicit key means "whatever this host already has" — an EC2 instance
    // profile or an SSO session. Measuring from inside the region is the only
    // way to get a number that resembles what the worker will see.
    const credentials = process.env.S3_ACCESS_KEY
      ? `KEY_ID '${process.env.S3_ACCESS_KEY}', SECRET '${process.env.S3_SECRET_KEY ?? ''}',
         ${process.env.S3_SESSION_TOKEN ? `SESSION_TOKEN '${process.env.S3_SESSION_TOKEN}',` : ''}`
      : `PROVIDER credential_chain,`
    secret = `CREATE OR REPLACE SECRET bench (
      TYPE s3,
      ${credentials}
      REGION '${process.env.S3_REGION ?? 'us-east-1'}'
      ${endpoint ? `, ENDPOINT '${endpoint.host}', USE_SSL ${endpoint.protocol === 'https:'}, URL_STYLE 'path'` : ''}
    )`
    await conn.run(secret)
  }
  await conn.run(`ATTACH 'ducklake:${catalog}' AS lake (DATA_PATH '${dataPath}')`)
  // As production does (ADR-043 §6-1): inlined rows would live in the catalog
  // rather than in the files this measures.
  await conn.run(`CALL lake.set_option('data_inlining_row_limit', 0)`)

  const q = async (sql: string) =>
    (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]
  const liveFiles = async () =>
    Number(
      (await q(`SELECT file_count FROM ducklake_table_info('lake') WHERE table_name = 't'`))[0]
        .file_count
    )
  const payload = SHAPE === 'wide' ? WIDE_PAYLOAD : `'v' || i`

  /**
   * One version: appends rows and corrects a few, the shape administrative data
   * takes — issued the way ii-b will issue it (`keyed-load`).
   *
   * The source is the whole version, not the delta, because that is what arrives:
   * a version is a file. `FIX_PERIOD` gives each id one version at which it is
   * corrected, so a correction sticks in every later version rather than being
   * undone by the next source that does not carry it.
   *
   * Not an INSERT plus an UPDATE, which is what this measured before: that is
   * two statements, so two snapshots per version, and the unpredicated UPDATE
   * rewrites whole files. Neither is the write path §11-2.1 is about.
   */
  const [upsert, remove] = keyedLoadSql({
    table: 'lake.t',
    source: 'src',
    keys: ['id'],
    values: ['name'],
  })
  const versionRows = (v: number) =>
    `SELECT i AS id,
       CASE WHEN (hash(i) % ${FIX_PERIOD}) BETWEEN 1 AND ${v}
            THEN 'fix' || (hash(i) % ${FIX_PERIOD}) || '_' || i
            ELSE ${payload} END AS name
     FROM range(${BASE + v * APPEND}) t(i)`
  const writeVersion = async (v: number) => {
    await conn.run(`CREATE OR REPLACE TABLE src AS ${versionRows(v)}`)
    await conn.run('BEGIN TRANSACTION')
    await conn.run(upsert)
    await conn.run(remove)
    await conn.run('COMMIT')
  }

  const startedAt = performance.now()
  await conn.run(`CREATE TABLE lake.t AS ${versionRows(0)}`)
  let merges = 0
  let mergeMs = 0
  for (let v = 1; v <= VERSIONS; v++) {
    await writeVersion(v)
    if (threshold !== null && (await liveFiles()) >= threshold) {
      const at = performance.now()
      await conn.run(`CALL ducklake_merge_adjacent_files('lake')`)
      mergeMs += performance.now() - at
      merges++
    }
  }
  const buildSeconds = (performance.now() - startedAt) / 1000

  // The worst case is the read just before the next merge, not the one after
  // the last — measuring at a multiple of the threshold flatters every arm.
  let v = VERSIONS + 1
  while (threshold !== null && (await liveFiles()) < threshold - 1 && v < VERSIONS + 2000) {
    await writeVersion(v++)
  }
  const worstFiles = await liveFiles()

  /**
   * The first scan of a fresh process. DuckDB's external file cache is per
   * instance, so a new one is cold by construction — and measured to be: the
   * cache setting changes the *second* scan by 50x and the first not at all.
   * Rebuilding the instance is what makes it cold, not disabling the cache.
   */
  const coldScan = async (threads?: number) => {
    const cold = await (await DuckDBInstance.create(':memory:')).connect()
    await cold.run(`INSTALL ducklake`)
    await cold.run(`LOAD ducklake`)
    if (!local) {
      await cold.run(`INSTALL httpfs`)
      await cold.run(`LOAD httpfs`)
      await cold.run(secret)
    }
    if (threads !== undefined) await cold.run(`SET threads = ${threads}`)
    await cold.run(`ATTACH 'ducklake:${catalog}' AS lake (DATA_PATH '${dataPath}')`)
    const at = performance.now()
    await (await cold.runAndReadAll(`SELECT count(*), max(name) FROM lake.t`)).getRowObjectsJson()
    const ms = performance.now() - at
    cold.disconnectSync()
    return ms
  }

  const coldScanMs = await coldScan()
  // The same scan repeated on a connection that has already read the files —
  // what a long-lived process sees from its second query on. Both regimes are
  // real, and reporting only this one understates the cost by an order.
  const at = performance.now()
  for (let k = 0; k < 3; k++) await q(`SELECT count(*), max(name) FROM lake.t`)
  const warmScanMs = (performance.now() - at) / 3

  const byThreads: Array<{ threads: number; scanMs: number }> = []
  for (const threads of values['scan-threads']?.split(',').map(Number) ?? [])
    byThreads.push({ threads, scanMs: await coldScan(threads) })

  await conn.run(`CALL ducklake_cleanup_old_files('lake', cleanup_all => true)`)
  // Counted from the catalog rather than by listing the store, so a local run and
  // an S3 run are comparable. Historical files are included — they are what a
  // policy of keeping every snapshot leaves behind.
  const [size] = await q(
    `SELECT (SELECT coalesce(sum(file_size_bytes), 0) FROM __ducklake_metadata_lake.ducklake_data_file)
          + (SELECT coalesce(sum(file_size_bytes), 0) FROM __ducklake_metadata_lake.ducklake_delete_file)
       AS n`
  )
  const megabytes = Number(size.n) / 1e6

  conn.disconnectSync()
  if (local) rmSync(local, { recursive: true, force: true })
  return {
    threshold,
    merges,
    mergeSeconds: mergeMs / 1000,
    buildSeconds,
    worstFiles,
    coldScanMs,
    warmScanMs,
    megabytes,
    byThreads,
  }
}

const thresholds = values.thresholds.split(',').map((t) => (t.trim() === 'none' ? null : Number(t)))

// Reported because the threshold and the thread count are not independent: at
// the DuckDB default (the core count) T=100 costs 1.6x T=25, at threads=2 it
// costs 2.6x. A table of thresholds that does not say what `threads` was is a
// table about a machine, and production pins the setting rather than taking the
// default.
const [{ threads }] = (await (
  await (await DuckDBInstance.create(':memory:')).connect()
)
  .runAndReadAll(`SELECT current_setting('threads') AS threads`)
  .then((r) => r.getRowObjectsJson())) as Array<{ threads: number }>

console.log(
  `shape=${SHAPE} base=${BASE} versions=${VERSIONS} threads=${threads} (DuckDB default) ` +
    `data=${values.data ?? '(local temp dir)'}`
)
console.log('threshold  merges  mergeTime   build   worst files    cold scan    warm scan     size')
for (const t of thresholds) {
  const r = await run(t)
  console.log(
    `${String(r.threshold ?? 'none').padStart(9)}  ${String(r.merges).padStart(6)}  ` +
      `${r.mergeSeconds.toFixed(1).padStart(8)}s  ${r.buildSeconds.toFixed(1).padStart(6)}s  ` +
      `${String(r.worstFiles).padStart(11)}  ${r.coldScanMs.toFixed(1).padStart(9)} ms  ` +
      `${r.warmScanMs.toFixed(1).padStart(9)} ms  ${r.megabytes.toFixed(1).padStart(7)} MB`
  )
  for (const { threads, scanMs } of r.byThreads) {
    console.log(
      `           threads=${String(threads).padStart(3)}  scan=${scanMs.toFixed(1).padStart(8)} ms`
    )
  }
}
