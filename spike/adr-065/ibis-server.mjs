// Static server for the ibisOffice measurements (ADR-065 §I).
//
//   node ibis-server.mjs [port]        (default 8766)
//
//   /                      ibis.html, the gallery to try the samples by hand
//   /manifest.json         the samples in data/samples
//   /files/<name>          one sample, by its file name (ibisOffice takes the
//                          name, and so the format, from the URL's last segment)
//   /lo/<name>.pdf         the LibreOffice PDF of that sample (data/lo-pdf)
//   /ibis/...              vendor/ibis-office/app as KUKAN would serve it:
//                          gzip, a year's Cache-Control on pkg/, and index.html
//                          with ibis-probe.js put in front of main.js
//   /ibis-csp/...          the same with `connect-src 'self'` and friends, to
//                          see whether the app runs under a strict CSP
//   /sandbox-host.html     ibisOffice in a sandboxed iframe (no allow-same-origin),
//                          the document handed over with postMessage
//                          (?open=<name>); /ibis-sandbox/ is that frame's boot page
import { createServer } from 'node:http'
import {
  readdirSync,
  statSync,
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, extname, resolve, basename } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname)
const app = join(root, 'vendor/ibis-office/app')
const samplesDir = join(root, 'data/samples')
const pdfDir = join(root, 'data/lo-pdf')
const port = Number(process.argv[2] ?? 8766)
const whoami = []

const samples = readdirSync(samplesDir)
  .filter((f) => /\.(docx?|pptx?|xlsx?)$/i.test(f))
  .sort()
  .map((name) => {
    const meta = existsSync(join(samplesDir, name + '.txt'))
      ? readFileSync(join(samplesDir, name + '.txt'), 'utf8').split('\n')
      : []
    return {
      name,
      ext: extname(name).slice(1).toLowerCase(),
      size: statSync(join(samplesDir, name)).size,
      source: meta[0] ?? '',
      title: meta[2] ?? '',
      pdf: existsSync(join(pdfDir, name.replace(/\.\w+$/, '.pdf'))),
    }
  })

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
}

// gzip once and keep it next to the original, as a CDN or Caddy would.
function gzipped(file) {
  const gz = file + '.gz'
  if (!existsSync(gz) || statSync(gz).mtimeMs < statSync(file).mtimeMs) {
    writeFileSync(gz, gzipSync(readFileSync(file), { level: 9 }))
  }
  return gz
}

// The page that embeds the sandboxed frame: the frame may only be the boot page
// (its path, not all of 'self'), so navigating the frame elsewhere, on this
// origin or another, is blocked too.
// ?probe on the host frames the probe page instead (and only that), so the secure
// boot page's frame can never be navigated to a page that runs the probes.
const hostCsp = (host, probe) =>
  `frame-src http://${host}/${probe ? 'ibis-sandbox-probe' : 'ibis-sandbox'}/boot.html`

// The sandboxed boot page: scripts and fetches from this server only.
// The sandboxed boot page's CSP, as ADR-065 decision 2 has it: scripts, images
// and fonts only from the boot page's and the app's paths, fetches only from the
// app's. The probe page alone may run the WebRTC probe and, with connect=self,
// open fetches to the whole site (the cookie test); the boot page reads no query.
// /ibis-probe.js is the harness's own instrument, allowed by name.
const sandboxCsp = (host, { connect, probe } = {}) =>
  [
    // Opaque origin even when the page is opened directly, outside the iframe.
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src http://${host}/ibis-sandbox/ ${probe ? `http://${host}/ibis-sandbox-probe/ ` : ''}http://${host}/ibis/ http://${host}/ibis-probe.js 'wasm-unsafe-eval'`,
    `connect-src ${connect === 'self' ? "'self'" : `http://${host}/ibis/`}`,
    `img-src http://${host}/ibis/ data: blob:`,
    "style-src 'unsafe-inline'",
    `font-src http://${host}/ibis/ data:`,
    "frame-ancestors 'self'",
  ].join('; ')

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
].join('; ')

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  // LOG_WASM=1 prints each request for the app's WASM (to see whether a page reload reads it again).
  if (process.env.LOG_WASM && url.pathname.endsWith('.wasm'))
    console.log('WASM', url.pathname, req.headers['sec-fetch-site'] ?? '')
  const path = decodeURIComponent(url.pathname)

  if (path === '/manifest.json') return send(res, 200, 'application/json', JSON.stringify(samples))
  if (path === '/' || path === '/ibis.html') return file(res, req, join(root, 'ibis.html'), {})
  if (path === '/ibis-probe.js') return file(res, req, join(root, 'ibis-probe.js'), {})
  // The host page, with frame-src limiting where the frame may go (?frameSrc=0 leaves it out,
  // to show the navigation leak it stops). With ?rtc= or ?connect=self it frames the
  // probe page, and only that.
  if (path === '/sandbox-host.html') {
    const probe =
      url.searchParams.has('rtc') ||
      url.searchParams.has('memMax') ||
      url.searchParams.has('dns') ||
      url.searchParams.get('connect') === 'self'
    return file(
      res,
      req,
      join(root, 'sandbox-host.html'),
      url.searchParams.get('frameSrc') === '0'
        ? {}
        : { 'Content-Security-Policy': hostCsp(req.headers.host, probe) }
    )
  }
  // What reached the server from the frame, recorded here: CORS only stops the
  // frame reading the answer, not the request going out (/whoami-log reads it back).
  if (path === '/whoami') {
    whoami.push({ at: Date.now(), cookie: req.headers.cookie ?? null })
    return send(res, 200, 'application/json', '{}', { 'Access-Control-Allow-Origin': '*' })
  }
  if (path === '/whoami-log')
    return send(res, 200, 'application/json', JSON.stringify(whoami.splice(0)))
  // The boot page for a sandboxed iframe (opaque origin), and its module.
  // It takes no query: what a navigation to it carries changes nothing.
  if (path === '/ibis-sandbox/boot.html')
    return file(res, req, join(root, 'sandbox-boot.html'), {
      'Content-Security-Policy': sandboxCsp(req.headers.host),
      // CSP does not cover DNS prefetching; a hostname can carry data out.
      'X-DNS-Prefetch-Control': 'off',
    })
  // The probe page: the same boot page with the WebRTC probe run first, on a path
  // of its own that the secure host does not frame.
  if (path === '/ibis-sandbox-probe/boot.html') {
    const html = readFileSync(join(root, 'sandbox-boot.html'), 'utf8').replace(
      '<script type="module" src="/ibis-sandbox/boot.js"></script>',
      '<script type="module" src="/ibis-sandbox-probe/rtc.js"></script>\n    <script type="module" src="/ibis-sandbox/boot.js"></script>'
    )
    return send(res, 200, types['.html'], html, {
      // ?dnsPrefetch=on leaves the header out, to show the lookup it stops.
      ...(url.searchParams.get('dnsPrefetch') === 'on' ? {} : { 'X-DNS-Prefetch-Control': 'off' }),
      'Content-Security-Policy': sandboxCsp(req.headers.host, {
        connect: url.searchParams.get('connect'),
        probe: true,
      }),
    })
  }
  if (path === '/ibis-sandbox-probe/rtc.js')
    return file(res, req, join(root, 'sandbox-rtc-probe.js'), {
      'Access-Control-Allow-Origin': '*',
    })
  // A same-origin script outside the allowed paths: the boot page tries to load it
  // and must be refused.
  if (path === '/sandbox-forbidden.js')
    return send(res, 200, 'text/javascript', 'window.__forbiddenRan = true', {
      'Access-Control-Allow-Origin': '*',
    })
  if (path === '/ibis-sandbox/boot.js')
    return file(res, req, join(root, 'sandbox-boot.js'), { 'Access-Control-Allow-Origin': '*' })

  let m = path.match(/^\/files\/([^/]+)$/)
  if (m) {
    const s = samples.find((s) => s.name === m[1])
    return s
      ? file(res, req, join(samplesDir, s.name), { 'Cache-Control': 'no-store' })
      : notFound(res)
  }
  m = path.match(/^\/lo\/([^/]+\.pdf)$/)
  if (m) return file(res, req, join(pdfDir, basename(m[1])), {})

  m = path.match(/^\/(ibis|ibis-csp)(\/.*)$/)
  if (m) {
    const headers = m[1] === 'ibis-csp' ? { 'Content-Security-Policy': CSP } : {}
    let rel = m[2] === '/' ? '/index.html' : m[2]
    const target = resolve(app, '.' + rel)
    if (!target.startsWith(app)) return notFound(res)
    if (rel === '/index.html') {
      const html = readFileSync(target, 'utf8').replace(
        '<script type="module" src="./main.js"></script>',
        '<script src="/ibis-probe.js"></script>\n    <script type="module" src="./main.js"></script>'
      )
      return send(res, 200, types['.html'], html, { ...headers, 'Cache-Control': 'no-store' })
    }
    const cache = rel.startsWith('/pkg/')
      ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
      : { 'Cache-Control': 'public, max-age=3600' }
    // A sandboxed frame has an opaque origin, so its module scripts, the
    // WASM and the icons are cross-origin requests to it.
    return file(res, req, target, { ...headers, ...cache, 'Access-Control-Allow-Origin': '*' })
  }
  notFound(res)
}).listen(port, () => console.log(`http://localhost:${port}/  samples=${samples.length}`))

function file(res, req, path, headers) {
  if (!existsSync(path) || statSync(path).isDirectory()) return notFound(res)
  const type = types[extname(path)] ?? 'application/octet-stream'
  const compressible = /\.(wasm|js|mjs|html|json|svg|md|css)$/.test(path)
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const gz = gzipped(path)
    res.writeHead(200, {
      ...headers,
      'Content-Type': type,
      'Content-Encoding': 'gzip',
      'Content-Length': statSync(gz).size,
      Vary: 'Accept-Encoding',
    })
    return createReadStream(gz).pipe(res)
  }
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': statSync(path).size })
  createReadStream(path).pipe(res)
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': type })
  res.end(body)
}

function notFound(res) {
  res.writeHead(404)
  res.end('not found')
}
