// ADR-048 spike: static server with two Range personalities.
//
//   ideal — full RFC 7233: exact ranges, suffix (`bytes=-N`), open-ended to EOF
//   proxy — byte-for-byte emulation of /api/v1/resources/:id/preview
//           (packages/api/src/routes/resources.ts): regex `bytes=(\d+)-(\d*)`,
//           suffix form falls through to 416, open-ended clamped to 1 MB,
//           plain GET streams 200 without Content-Length, HEAD mirrors GET
//           headers (Hono serves HEAD via the GET handler).
//
// Also serves the duckdb-wasm dist and the measurement page, and exposes
// per-request stats so the driver can attribute bytes to scenarios.
import { createServer } from 'http'
import { createReadStream, statSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, normalize } from 'path'
import { createRequire } from 'module'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromWeb = createRequire(join(here, '../../apps/web/package.json'))
const distDir = join(dirname(requireFromWeb.resolve('@duckdb/duckdb-wasm/dist/duckdb-browser.mjs')))

const DEFAULT_RANGE_CHUNK = 1024 * 1024 // packages/api/src/config.ts

let stats = { requests: [] }

export function startServer({ port = 0, mode = 'ideal' } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const record = (status, bytes, extra = {}) => {
      stats.requests.push({
        method: req.method,
        path: url.pathname,
        range: req.headers.range ?? null,
        status,
        bytes,
        ...extra,
      })
    }

    if (url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }
    if (url.pathname === '/__reset') {
      stats = { requests: [] }
      res.writeHead(200).end('ok')
      return
    }
    if (url.pathname === '/' || url.pathname === '/page.html') {
      const html = readFileSync(join(here, 'page.html'))
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
      return
    }
    if (url.pathname.startsWith('/vendor/')) {
      const file = join(here, 'vendor', normalize(url.pathname.slice(8)))
      if (!file.startsWith(join(here, 'vendor'))) return res.writeHead(403).end()
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      createReadStream(file).pipe(res)
      return
    }
    if (url.pathname.startsWith('/dist/')) {
      const file = join(distDir, normalize(url.pathname.slice(6)))
      if (!file.startsWith(distDir)) return res.writeHead(403).end()
      const type = file.endsWith('.wasm')
        ? 'application/wasm'
        : file.endsWith('.mjs')
          ? 'text/javascript'
          : 'text/javascript'
      const size = statSync(file).size
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size })
      createReadStream(file).pipe(res)
      return
    }
    if (!url.pathname.startsWith('/data/')) {
      res.writeHead(404).end()
      return
    }

    const file = join(here, 'data', normalize(url.pathname.slice(6)))
    let size
    try {
      size = statSync(file).size
    } catch {
      record(404, 0)
      res.writeHead(404).end()
      return
    }
    const contentType = 'application/vnd.apache.parquet'
    const rangeHeader = req.headers.range

    const serve = (status, headers, start, end) => {
      const bytes = req.method === 'HEAD' || start == null ? 0 : end - start + 1
      record(status, bytes)
      res.writeHead(status, headers)
      if (req.method === 'HEAD' || start == null) return res.end()
      createReadStream(file, { start, end }).pipe(res)
    }

    if (mode === 'proxy') {
      // --- emulation of resources.ts /preview ---
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (!match) {
          record(416, 0)
          res.writeHead(416).end('Invalid Range')
          return
        }
        const start = parseInt(match[1], 10)
        let end = match[2] ? parseInt(match[2], 10) : start + DEFAULT_RANGE_CHUNK - 1
        end = Math.min(end, size - 1) // S3 clamps to object size
        serve(
          206,
          {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=300',
          },
          start,
          end
        )
        return
      }
      // Full response: streamed, Accept-Ranges advertised, no Content-Length
      // (Hono streams the storage body; HEAD gets the same headers, no body).
      const headers = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
      }
      if (req.method === 'HEAD') return serve(200, headers, null, null)
      serve(200, headers, 0, size - 1)
      return
    }

    // --- ideal mode: full RFC 7233 ---
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      let start, end
      if (m && m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - parseInt(m[2], 10)) // suffix
        end = size - 1
      } else if (m && m[1] !== '') {
        start = parseInt(m[1], 10)
        end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
      } else {
        record(416, 0)
        res.writeHead(416).end()
        return
      }
      serve(
        206,
        {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
        start,
        end
      )
      return
    }
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    }
    if (req.method === 'HEAD') return serve(200, headers, null, null)
    serve(200, headers, 0, size - 1)
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'ideal'
  const { port } = await startServer({ port: 8977, mode })
  console.log(`spike server (${mode}) on http://127.0.0.1:${port}`)
}
