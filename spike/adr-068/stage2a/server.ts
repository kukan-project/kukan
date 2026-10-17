// ADR-068 stage 2a: KUKAN's own query path on a Web Function, without a VPC.
//
// Bundled from the real modules, so what runs is the web's: runQueryInProcess
// forks query-child.mjs, watches its RSS against the budget and kills it past
// it; the child opens the sandboxed DuckDB, materializes the Parquet through
// httpfs from a presigned URL and runs the SQL. /inproc opens DuckDB in this
// process instead, as the OData feed does (ADR-055).
//
// Every route needs the token in token.txt; the endpoint is public.
import http from 'node:http'
import { readFileSync, statfsSync } from 'node:fs'
import { freemem, totalmem, tmpdir } from 'node:os'
import { runQueryInProcess } from '../../../packages/api/src/services/query/query-process'
import {
  QUERY_MAX_BYTES,
  QUERY_MAX_ROWS,
  QUERY_MEMORY_LIMIT_MB,
  QUERY_PROCESS_RSS_MB,
  QUERY_THREADS,
  QUERY_TIMEOUT_MS,
} from '../../../packages/api/src/config'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  forgetEnvironmentCredentials,
  loadDuckdbExtensions,
  openDuckdb,
} from '../../../packages/lake/src/index'
import { networkRoute } from '../stage2b/routes'

const STARTED = Date.now()
let listenedAt = 0
const TOKEN = (() => {
  try {
    return readFileSync(new URL('./token.txt', import.meta.url), 'utf8').trim()
  } catch {
    return ''
  }
})()

const s3 = new S3Client({})

/** A presigned URL from this function's own role; `url` as given otherwise. */
async function source(body: Record<string, string>): Promise<string> {
  if (body.bucket && body.key) {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: body.bucket, Key: body.key }), {
      expiresIn: 300,
    })
  }
  return body.url
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

function meminfo() {
  const text = readFileSync('/proc/meminfo', 'utf8')
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
  return {
    totalMb: Math.round(kb('MemTotal') / 1024),
    availableMb: Math.round(kb('MemAvailable') / 1024),
    usedMb: Math.round((kb('MemTotal') - kb('MemAvailable')) / 1024),
  }
}

function state() {
  const t = statfsSync(tmpdir())
  return {
    pid: process.pid,
    uptimeS: Math.round(process.uptime()),
    rssMb: mb(process.memoryUsage().rss),
    meminfo: meminfo(),
    totalmemMb: mb(totalmem()),
    freememMb: mb(freemem()),
    tmpFreeMb: mb(t.bavail * t.bsize),
  }
}

function limits(url: URL) {
  const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d) || d
  return {
    maxRows: num('rows', QUERY_MAX_ROWS),
    maxBytes: QUERY_MAX_BYTES,
    timeoutMs: num('timeoutMs', QUERY_TIMEOUT_MS),
    memoryLimitMb: num('memMb', QUERY_MEMORY_LIMIT_MB),
    threads: num('threads', QUERY_THREADS),
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

// DuckDB in this process, as the OData feed keeps its instances
async function inProcess(location: string, sql: string, memMb: number) {
  const { conn, close } = await openDuckdb({
    memoryLimitBytes: memMb * 1_000_000,
    threads: QUERY_THREADS,
    spill: 'inproc',
  })
  try {
    await loadDuckdbExtensions(conn, ['httpfs'])
    await forgetEnvironmentCredentials(conn)
    await conn.run(
      `CREATE VIEW data AS SELECT * FROM read_parquet('${location.replace(/'/g, "''")}')`
    )
    const reader = await conn.runAndReadAll(sql)
    return { rows: reader.getRowObjectsJson().slice(0, 20), rowCount: reader.currentRowCount }
  } finally {
    await close()
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://probe')
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body, null, 2))
  }
  if (!TOKEN || req.headers['x-probe-token'] !== TOKEN) return send(403, { error: 'token' })
  const t0 = Date.now()
  try {
    if (url.pathname === '/state') {
      return send(200, {
        ...state(),
        startupMs: listenedAt - STARTED,
        budgets: { QUERY_PROCESS_RSS_MB, QUERY_MEMORY_LIMIT_MB, QUERY_THREADS },
        env: {
          DUCKDB_EXTENSION_DIRECTORY: process.env.DUCKDB_EXTENSION_DIRECTORY ?? null,
          QUERY_CHILD_ENTRY: process.env.QUERY_CHILD_ENTRY ?? null,
        },
      })
    }
    // POST { bucket, key } or { url }: why httpfs cannot read what Node can.
    // Error text has the URL cut out.
    if (url.pathname === '/diag') {
      const location = await source(await readBody(req))
      const hide = (s: string) => s.replace(/https:\/\/\S+/g, '<url>')
      let nodeFetch: unknown
      try {
        const r = await fetch(location, { headers: { range: 'bytes=0-3' } })
        nodeFetch = { status: r.status, body: (await r.text()).slice(0, 200) }
      } catch (e) {
        nodeFetch = { error: hide(String(e)) }
      }
      const duck = async (target: string, setup: string[]) => {
        const { conn, close } = await openDuckdb({ spill: null })
        try {
          await loadDuckdbExtensions(conn, ['httpfs'])
          await conn.run("CALL enable_logging('HTTP')")
          for (const s of setup) await conn.run(s)
          try {
            const r = await conn.runAndReadAll(
              `SELECT count(*) n FROM read_parquet('${target.replace(/'/g, "''")}')`
            )
            return { setup, ok: r.getRowObjectsJson()[0] }
          } catch (e) {
            const logs = await conn
              .runAndReadAll('SELECT type, log_level, message FROM duckdb_logs ORDER BY timestamp')
              .then((r) => r.getRowObjectsJson().slice(-4))
              .catch((le) => [{ logError: String(le) }])
            return {
              setup,
              error: hide((e as Error).message).split('\n')[0],
              logs: JSON.parse(hide(JSON.stringify(logs))),
            }
          }
        } finally {
          await close()
        }
      }
      const PUBLIC = 'https://blobs.duckdb.org/train_services.parquet'
      const duckdb = []
      for (const [target, setup] of [
        [location, []],
        [location, ["SET httpfs_client_implementation = 'curl'"]],
        [location, ["SET httpfs_client_implementation = 'httplib'"]],
        [PUBLIC, []],
        [PUBLIC, ["SET httpfs_client_implementation = 'curl'"]],
      ] as [string, string[]][]) {
        duckdb.push({
          target: target === PUBLIC ? PUBLIC : '<presigned>',
          ...(await duck(target, setup)),
        })
      }
      return send(200, { nodeFetch, duckdb })
    }
    // POST { url, sql }: the presigned URL is too long for a query string
    if (url.pathname === '/query' || url.pathname === '/inproc') {
      const body = await readBody(req)
      const location = await source(body)
      const sql = body.sql
      const before = state()
      const lim = limits(url)
      const rssBudgetMb = Number(url.searchParams.get('budgetMb') ?? QUERY_PROCESS_RSS_MB)
      let result: unknown
      let error: unknown = null
      try {
        result =
          url.pathname === '/query'
            ? await runQueryInProcess(location, sql, lim, { rssBudgetMb })
            : await inProcess(location, sql, lim.memoryLimitMb)
      } catch (e) {
        // The in-process path does not hide the URL as the child does; cut it here
        const err = e as Error & { status?: number }
        const message = err.message.replace(/https:\/\/\S+/g, '<url>')
        error = { name: err.name, status: err.status ?? null, message }
      }
      const summary =
        result && typeof result === 'object' && 'rows' in result
          ? { ...(result as object), rows: (result as { rows: unknown[] }).rows.slice(0, 5) }
          : result
      return send(200, {
        elapsedMs: Date.now() - t0,
        limits: lim,
        rssBudgetMb,
        before,
        after: state(),
        error,
        result: summary,
      })
    }
    const net = await networkRoute(url.pathname)
    if (net) return send(200, { elapsedMs: Date.now() - t0, ...(net as object) })
    return send(404, {
      routes: [
        '/state',
        'POST /query',
        'POST /inproc',
        'POST /diag',
        '/secret',
        '/db',
        '/egress',
        '/bedrock',
      ],
    })
  } catch (e) {
    return send(500, { error: (e as Error).stack })
  }
})

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000').split(':')
server.listen(Number(port), host, () => {
  listenedAt = Date.now()
  console.log(JSON.stringify({ msg: 'listening', startupMs: listenedAt - STARTED }))
})
process.on('SIGTERM', () => process.exit(0))
