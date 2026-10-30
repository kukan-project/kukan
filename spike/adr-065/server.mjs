// Static server for the harness pages. Paths under /iso/ are served with the
// COOP/COEP pair ZetaOffice needs (SharedArrayBuffer); the same files without
// the prefix are served plain, so the two can be compared from one server.
//
//   SAMPLES=/path/to/files node server.mjs [port]
//
// /manifest.json lists the sample files, /sample/<i> streams one.
import { createServer } from 'node:http'
import { readdirSync, statSync, createReadStream, existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const root = resolve(import.meta.dirname)
const samplesDir = process.env.SAMPLES
if (!samplesDir) throw new Error('SAMPLES is not set')
const port = Number(process.argv[2] ?? 8765)

const samples = readdirSync(samplesDir)
  .filter((f) => /\.(docx?|pptx?|xlsx?)$/i.test(f))
  .sort()
  .map((name, i) => ({
    i,
    name,
    ext: extname(name).slice(1).toLowerCase(),
    size: statSync(join(samplesDir, name)).size,
  }))

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let path = url.pathname
  const isolated = path.startsWith('/iso/')
  if (isolated) path = path.slice(4)
  const headers = isolated
    ? {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }
    : {}

  if (path === '/manifest.json') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(samples))
    return
  }
  const m = path.match(/^\/sample\/(\d+)$/)
  if (m) {
    const s = samples[Number(m[1])]
    if (!s) return notFound(res)
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': s.size,
    })
    createReadStream(join(samplesDir, s.name)).pipe(res)
    return
  }
  const file = resolve(root, '.' + path)
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    return notFound(res)
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
  })
  createReadStream(file).pipe(res)
}).listen(port, () => console.log(`http://localhost:${port}/  samples=${samples.length}`))

function notFound(res) {
  res.writeHead(404)
  res.end('not found')
}
