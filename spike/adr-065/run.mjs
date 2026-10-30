// Playwright driver.
//   node run.mjs light [--out DIR] [--only docx,pptx]   docx-preview / pptx-renderer
//   node run.mjs zeta  [--out DIR] [--only xls,doc]     ZetaOffice, one browser, cold then warm start
//   node run.mjs frame [--out DIR]                      ZetaOffice without cross-origin isolation
// Needs server.mjs on $PORT (default 8765). Writes results-<mode>.json and
// screenshots under --out (default ./results). Memory is the renderer's JS heap
// plus, for ZetaOffice, the WASM linear memory — what the page itself holds.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, ...rest] = process.argv.slice(2)
const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : './results'
const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1].split(',') : null
const base = `http://localhost:${process.env.PORT ?? 8765}`
mkdirSync(out, { recursive: true })

const manifest = await (await fetch(`${base}/manifest.json`)).json()
const picked = only ? manifest.filter((s) => only.includes(s.ext)) : manifest

const browser = await chromium.launch()
const results = []

async function heapMb(page) {
  const session = await page.context().newCDPSession(page)
  const { metrics } = await session.send('Performance.getMetrics')
  await session.detach()
  const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  return Math.round(used / 1048576)
}

const pad = (i) => String(i).padStart(3, '0')

if (mode === 'light') {
  for (const s of picked.filter((s) => s.ext === 'docx' || s.ext === 'pptx')) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } })
    const consoleErrors = []
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)))
    const t0 = Date.now()
    let r
    try {
      await page.goto(`${base}/page-light.html?i=${s.i}`)
      await page.waitForFunction(() => window.__result, null, { timeout: 90_000 })
      r = await page.evaluate(() => window.__result)
    } catch (err) {
      r = {
        i: s.i,
        name: s.name,
        ext: s.ext,
        size: s.size,
        ok: false,
        errors: [String(err.message).slice(0, 200)],
      }
    }
    r.wallMs = Date.now() - t0
    r.heapMb = await heapMb(page)
    r.consoleErrors = consoleErrors.slice(0, 5)
    if (r.ok) {
      r.shot = `light-${pad(s.i)}.png`
      await page.screenshot({
        path: join(out, r.shot),
        clip: { x: 0, y: 0, width: 1000, height: Math.min(r.height + 40, 3000) },
      })
    }
    console.log(JSON.stringify(r))
    results.push(r)
    await page.close()
  }
}

if (mode === 'zeta') {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await context.newPage()
  const consoleLines = []
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 200)}`))
  // Bytes that crossed the network from the CDN: the encoded length CDP reports
  // when a response finishes loading, which is about zero for one served from
  // the browser's cache. (A response's Content-Length is the same either way,
  // so it would not show a warm start reading nothing.)
  let cdn = { responses: 0, fromCache: 0, bytes: 0 }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  const cdnRequests = new Map()
  cdp.on('Network.responseReceived', (e) => {
    if (!e.response.url.includes('cdn.zetaoffice.net')) return
    cdnRequests.set(e.requestId, e.response.fromDiskCache || e.response.fromMemoryCache)
  })
  cdp.on(
    'Network.requestServedFromCache',
    (e) => cdnRequests.has(e.requestId) && cdnRequests.set(e.requestId, true)
  )
  cdp.on('Network.loadingFinished', (e) => {
    if (!cdnRequests.has(e.requestId)) return
    cdn.responses++
    if (cdnRequests.get(e.requestId)) cdn.fromCache++
    else cdn.bytes += e.encodedDataLength
    cdnRequests.delete(e.requestId)
  })
  const startup = {}
  for (const pass of ['cold', 'warm']) {
    cdn = { responses: 0, fromCache: 0, bytes: 0 }
    const t0 = Date.now()
    await page.goto(`${base}/iso/page-zeta.html`)
    const ready = await page
      .waitForFunction(() => window.__ready, null, { timeout: 300_000 })
      .then(
        () => true,
        () => false
      )
    startup[pass] = {
      ready,
      wallMs: Date.now() - t0,
      ...(await page.evaluate(() => window.__status)),
      cdnResponses: cdn.responses,
      cdnFromCache: cdn.fromCache,
      cdnMb: Math.round(cdn.bytes / 1048576),
      heapMb: await heapMb(page),
      wasmMb: await page.evaluate(() => Math.round((window.Module?.HEAPU8?.length ?? 0) / 1048576)),
    }
    console.log(pass, JSON.stringify(startup[pass]))
    if (!ready) break
  }
  results.push({ startup })
  if (startup.cold?.ready) {
    for (const s of picked) {
      const t0 = Date.now()
      let r
      try {
        r = await Promise.race([
          page.evaluate((i) => window.__open(i), s.i),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 120s')), 120_000)),
        ])
        r.ok = true
        await page.waitForTimeout(1500) // let Qt paint
        r.shot = `zeta-${pad(s.i)}.png`
        await page.screenshot({
          path: join(out, r.shot),
          clip: { x: 50, y: 0, width: 1100, height: 800 },
        })
      } catch (err) {
        r = {
          name: s.name,
          ext: s.ext,
          size: s.size,
          ok: false,
          error: String(err.message).slice(0, 300),
        }
      }
      r.i = s.i
      r.wallMs = Date.now() - t0
      r.heapMb = await heapMb(page)
      r.wasmMb = await page.evaluate(() =>
        Math.round((window.Module?.HEAPU8?.length ?? 0) / 1048576)
      )
      console.log(JSON.stringify(r))
      results.push(r)
      if (!r.ok && /timeout/.test(r.error)) break // the office thread is wedged
    }
  }
  results.push({ consoleTail: consoleLines.slice(-30) })
}

if (mode === 'frame') {
  // 1. Plain top-level page, no isolation: does soffice.js start at all?
  const page = await browser.newPage()
  const lines = []
  page.on('console', (m) => lines.push(`${m.type()}: ${m.text().slice(0, 200)}`))
  page.on('pageerror', (e) => lines.push(`pageerror: ${String(e.message).slice(0, 200)}`))
  await page.goto(`${base}/page-zeta.html`)
  const ready = await page
    .waitForFunction(() => window.__ready, null, { timeout: 90_000 })
    .then(
      () => true,
      () => false
    )
  results.push({
    case: 'plain top-level',
    ready,
    status: await page.evaluate(() => window.__status),
    console: lines.slice(0, 10),
  })
  await page.close()
  // 2. Isolated iframe inside a non-isolated top-level page
  const page2 = await browser.newPage()
  await page2.setContent(
    `<iframe id="f" src="${base}/iso/page-zeta.html" width="1100" height="800"></iframe>`
  )
  await page2.waitForTimeout(2000)
  const frame = page2.frames().find((f) => f.url().includes('page-zeta'))
  const ready2 = frame
    ? await frame
        .waitForFunction(() => window.__ready, null, { timeout: 90_000 })
        .then(
          () => true,
          () => false
        )
    : false
  results.push({
    case: 'isolated iframe in plain top',
    ready: ready2,
    status: frame ? await frame.evaluate(() => window.__status) : null,
  })
  await page2.close()
  console.log(JSON.stringify(results, null, 2))
}

writeFileSync(join(out, `results-${mode}.json`), JSON.stringify(results, null, 2))
await browser.close()
