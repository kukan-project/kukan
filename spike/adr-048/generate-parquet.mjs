// ADR-048 spike: generate synthetic preview-like Parquet files.
// Matches Interpret's write settings (zstd, ROW_GROUP_SIZE) at two granularities.
// Usage: node spike/adr-048/generate-parquet.mjs [rows]
import { createRequire } from 'module'
import { mkdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromWorker = createRequire(join(here, '../../apps/worker/src/index.ts'))
const { DuckDBInstance } = requireFromWorker('@duckdb/node-api')

const rows = Number(process.argv[2] ?? 6_000_000)
const dataDir = join(here, 'data')
mkdirSync(dataDir, { recursive: true })

// Mixed columns like a typed CSV interpretation: ids, numerics, dates,
// low-cardinality strings, and two high-entropy strings so zstd cannot
// flatten the file into nothing.
const select = `
  SELECT
    i                                         AS id,
    (random() * 1e6)::BIGINT                  AS num_a,
    random() * 1000                           AS num_b,
    (TIMESTAMP '2020-01-01' + INTERVAL (i % 100000) SECOND)::VARCHAR AS ts_text,
    ['Sapporo','Sendai','Tokyo','Nagoya','Osaka','Hiroshima','Fukuoka'][1 + i % 7] AS str_city,
    md5(i::VARCHAR)                           AS str_hash,
    md5((i * 31)::VARCHAR) || md5((i * 37)::VARCHAR) AS str_note
  FROM range(${rows}) t(i)
`

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()

for (const [name, rowGroup] of [
  ['rg5000', 5000],
  ['rg100k', 100000],
]) {
  const path = join(dataDir, `${name}.parquet`)
  const t0 = Date.now()
  await conn.run(
    `COPY (${select}) TO '${path}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${rowGroup})`
  )
  const mb = (statSync(path).size / 1024 / 1024).toFixed(1)
  console.log(`${name}.parquet: ${mb} MB, ${rows} rows, ${(Date.now() - t0) / 1000}s`)
}

// Per-column compressed sizes feed the "sort transfer <= 1.5x column size" criterion.
const reader = await conn.runAndReadAll(`
  SELECT path_in_schema AS col,
         ROUND(SUM(total_compressed_size) / 1024.0 / 1024, 1) AS compressed_mb
  FROM parquet_metadata('${join(dataDir, 'rg5000.parquet')}')
  GROUP BY 1 ORDER BY 2 DESC
`)
console.table(reader.getRowObjects())
