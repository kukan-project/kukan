// Playwright driver for ibisOffice (ADR-065 §I). Needs ibis-server.mjs on
// $PORT (default 8766) and a Chromium with a display (WebGPU does not draw
// in headless mode here).
//
//   CHROME=/path/to/chrome node run-ibis.mjs [--out DIR] [--only xls,xlsx] [--csp] [--no-scroll]
//
// One persistent profile, so the first document pays the cold start (WASM
// download and compile) and the rest run warm, as a viewer's second visit
// would. Per document: the probe's marks (ibis-probe.js), the peak RSS of the
// renderer and GPU processes while it loads, frame gaps while scrolling, and a
// screenshot without the menu and tool bars. Writes results-ibis.json.
import { chromium } from 'playwright'
import { execSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null)
const out = opt('--out') ?? './results'
const only = opt('--only')?.split(',')
const prefix = argv.includes('--csp') ? '/ibis-csp/' : '/ibis/'
const base = `http://localhost:${process.env.PORT ?? 8766}`
mkdirSync(out, { recursive: true })

const manifest = await (await fetch(`${base}/manifest.json`)).json()
const picked = only ? manifest.filter((s) => only.includes(s.ext)) : manifest

// CDP=http://127.0.0.1:9333 drives a Chrome that is already running (on
// Windows, from WSL in mirrored networking mode), so it draws with the real
// GPU. Its processes are read with PowerShell, once after each load, as the
// working set of the processes whose command line names its profile (the
// profile path is given in CDP_PROFILE).
const cdp = process.env.CDP
const profile = cdp ? process.env.CDP_PROFILE : mkdtempSync(join(tmpdir(), 'ibis-profile-'))
const browser = cdp ? await chromium.connectOverCDP(cdp) : null
const context = cdp
  ? browser.contexts()[0]
  : await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME,
      headless: false,
      args: ['--enable-unsafe-webgpu', ...(process.env.ARGS ?? '').split(' ').filter(Boolean)],
      viewport: { width: 1280, height: 860 },
      locale: 'ja-JP',
    })

function windowsWorkingSet() {
  const ps = String.raw`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { $t = if ($_.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'browser' }; "$t $($_.WorkingSetSize)" }`
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const by = {}
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    cwd: '/mnt/c',
  })
  for (const l of stdout.split('\n')) {
    const m = l.trim().match(/^([\w-]+) (\d+)$/)
    if (m) by[m[1]] = Math.max(by[m[1]] ?? 0, Math.round(Number(m[2]) / 1048576))
  }
  return by
}

// RSS (MB) of this profile's Chromium processes, by --type.
function rss() {
  if (cdp) return {}
  const lines = execSync(`ps -eo rss=,args= | grep -F -- '${profile}' | grep -v grep`, {
    encoding: 'utf8',
  }).split('\n')
  const by = {}
  for (const l of lines) {
    const m = l.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const type = m[2].match(/--type=([\w-]+)/)?.[1] ?? 'browser'
    by[type] = Math.max(by[type] ?? 0, Math.round(Number(m[1]) / 1024))
  }
  return by
}

const pct = (a, p) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : null

if (cdp) {
  // Start cold: no cached WASM or compiled code from an earlier run.
  const page = await context.newPage()
  const session = await context.newCDPSession(page)
  await session.send('Network.clearBrowserCache')
  await session.detach()
  await page.close()
}

const results = []
for (const [n, s] of picked.entries()) {
  const page = await context.newPage()
  if (cdp) await page.setViewportSize({ width: 1280, height: 860 })
  const external = []
  page.on('request', (r) => !r.url().startsWith(base) && external.push(r.url()))
  const peak = {}
  const sampler = setInterval(() => {
    for (const [k, v] of Object.entries(rss())) peak[k] = Math.max(peak[k] ?? 0, v)
  }, 200)
  const t0 = Date.now()
  await page.goto(
    `${base}${prefix}?open=/files/${encodeURIComponent(s.name)}&view=1&menuBar=0&toolBar=0`
  )
  let st
  for (;;) {
    st = await page.evaluate(() => window.__ibis?.state).catch(() => null)
    if (st?.marks.drawn || st?.marks.failed || Date.now() - t0 > 90_000) break
    await page.waitForTimeout(100)
  }
  // Let a slow document finish its first pass, then read memory.
  await page.waitForTimeout(500)
  st = await page.evaluate(() => window.__ibis.state)
  clearInterval(sampler)
  if (cdp) Object.assign(peak, windowsWorkingSet())
  const r = {
    n,
    name: s.name,
    ext: s.ext,
    size: s.size,
    cold: n === 0,
    timedOut: !st.marks.drawn && !st.marks.failed,
    ...st,
    peakRssMb: peak,
    externalRequests: external,
  }
  r.shot = `ibis-${s.name}.png`
  await page.screenshot({ path: join(out, r.shot) })

  if (!argv.includes('--no-scroll') && st.marks.drawn) {
    // 30 wheel steps of 300 px, 50 ms apart, over the middle of the document.
    await page.mouse.move(640, 450)
    await page.evaluate(() => window.__ibis.resetGaps())
    const ts = Date.now()
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 300)
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(500)
    const gaps = (await page.evaluate(() => window.__ibis.gaps(5000))).filter((g) => g < 1000)
    r.scroll = {
      ms: Date.now() - ts,
      frames: gaps.length,
      gapP50: pct(gaps, 0.5),
      gapP95: pct(gaps, 0.95),
      gapMax: gaps.length ? Math.max(...gaps) : null,
    }
    await page.screenshot({ path: join(out, `ibis-${s.name}-scrolled.png`) })
  }
  const line = `${s.name} ${s.size}B ready=${st.marks.ready} drawn=${st.marks.drawn ?? '-'} wasm=${st.wasmMb}MB rss=${JSON.stringify(peak)} scroll=${JSON.stringify(r.scroll ?? null)} err=${st.errors.length} ext=${external.length}`
  console.log(line)
  results.push(r)
  await page.close()
}
if (cdp) await browser.close()
else await context.close()
writeFileSync(
  join(out, `results-ibis${prefix === '/ibis-csp/' ? '-csp' : ''}.json`),
  JSON.stringify(results, null, 1)
)
