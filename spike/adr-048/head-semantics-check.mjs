// ADR-048 review follow-up: does DuckDB-WASM range mode still activate when
// HEAD ignores Range (RFC 9110 §14.2 — range handling is defined for GET only)?
//
// The size probe turns out to be GET `bytes=0-0` followed by a HEAD whose
// Content-Length is read WITHOUT checking the status, so a 200 with the full
// length satisfies it. This script pins that: both HEAD personalities x both
// flag configs must reach RANGE-MODE.
//
// Usage: node spike/adr-048/head-semantics-check.mjs  (needs data/ + vendor/)
import { createRequire } from 'module'
import { createServer } from 'http'
import { createReadStream, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromWeb = createRequire(join(here, '../../apps/web/package.json'))
const { chromium } = requireFromWeb('@playwright/test')
const distDir = dirname(requireFromWeb.resolve('@duckdb/duckdb-wasm/dist/duckdb-browser.mjs'))

const makeServer = (headIgnoresRange, log) =>
  createServer((rq, rs) => {
    const url = new URL(rq.url, 'http://x')
    const path =
      url.pathname === '/page.html' || url.pathname === '/'
        ? join(here, 'page.html')
        : url.pathname.startsWith('/vendor/')
          ? join(here, url.pathname)
          : url.pathname.startsWith('/dist/')
            ? join(distDir, url.pathname.slice(6))
            : url.pathname.startsWith('/data/')
              ? join(here, url.pathname)
              : null
    if (!path) return rs.writeHead(404).end()
    let size
    try {
      size = statSync(path).size
    } catch {
      return rs.writeHead(404).end()
    }
    const type = path.endsWith('.wasm')
      ? 'application/wasm'
      : path.endsWith('.html')
        ? 'text/html'
        : path.endsWith('.parquet')
          ? 'application/octet-stream'
          : 'text/javascript'
    const range = rq.headers.range
    if (url.pathname.startsWith('/data/')) log.push(`${rq.method} ${range ?? 'full'}`)
    if (rq.method === 'HEAD' && (headIgnoresRange || !range)) {
      rs.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      return rs.end()
    }
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      let start, end
      if (m[1] === '') {
        start = size - parseInt(m[2], 10)
        end = size - 1
      } else {
        start = parseInt(m[1], 10)
        end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
      }
      rs.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      })
      if (rq.method === 'HEAD') return rs.end()
      return createReadStream(path, { start, end }).pipe(rs)
    }
    rs.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    if (rq.method === 'HEAD') return rs.end()
    createReadStream(path).pipe(rs)
  })

const browser = await chromium.launch()
let failed = false
for (const headIgnores of [false, true]) {
  const log = []
  const server = makeServer(headIgnores, log)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  for (const cfg of [
    { reliableHeadRequests: true, allowFullHTTPReads: true, forceFullHTTPReads: false },
    { reliableHeadRequests: false, allowFullHTTPReads: true, forceFullHTTPReads: false },
  ]) {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/page.html`)
    log.length = 0
    try {
      await page.evaluate(
        ([u, f]) => window.spikeInit(u, f, true),
        [`http://127.0.0.1:${port}/data/rg100k.parquet`, cfg]
      )
      await page.evaluate((q) => window.spikeQuery(q), "SELECT COUNT(*) FROM 'data.parquet'")
      const mode = log.some((l) => l === 'GET full') ? 'FULL-DOWNLOAD' : 'RANGE-MODE'
      if (mode !== 'RANGE-MODE') failed = true
      console.log(`headIgnoresRange=${headIgnores} cfg=${JSON.stringify(cfg)} => ${mode}`)
      console.log('   ', log.slice(0, 8).join(' | '))
    } catch (e) {
      failed = true
      console.log(
        `headIgnoresRange=${headIgnores} cfg=${JSON.stringify(cfg)} => ERROR`,
        String(e).split('\n')[0].slice(0, 120)
      )
    }
    await page.close()
  }
  server.close()
}
await browser.close()
console.log(failed ? '\nNG: range mode did not activate everywhere' : '\nOK: range mode everywhere')
process.exit(failed ? 1 : 0)
