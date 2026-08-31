// ADR-048 addendum: the second leg of the two-phase read.
//
// Leg 1 (sort-column projection) fixes the row positions of a sorted page;
// leg 2 fetches those rows by `file_row_number IN (...)`. This measures leg 2's
// real transfer: the visible rows of a sorted page scatter across the whole
// file, so the floor is (#row groups they land in) x (group size) — the basis
// for keeping full-buffer transport at the current generation cap (decision 4).
//
// Usage: node spike/adr-048/two-phase-check.mjs  (needs data/ + vendor/)
// Writes results-two-phase.json next to this script.
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync } from 'fs'
import { createRequire } from 'module'
import { startServer } from './server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromWeb = createRequire(join(here, '../../apps/web/package.json'))
const { chromium } = requireFromWeb('@playwright/test')

const { server, port } = await startServer({ mode: 'ideal' })
const stats = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/__stats`)).json()).requests.filter((r) =>
    r.path.startsWith('/data/')
  )
const reset = () => fetch(`http://127.0.0.1:${port}/__reset`)
const mb = (n) => Number((n / 1024 / 1024).toFixed(2))

const results = []
const browser = await chromium.launch()
for (const [file, rowGroup] of [
  ['rg5000.parquet', 5000],
  ['rg100k.parquet', 100000],
]) {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/page.html`)
  await page.evaluate(
    ([u, f, d]) => window.spikeInit(u, f, d),
    [
      `http://127.0.0.1:${port}/data/${file}`,
      { reliableHeadRequests: true, allowFullHTTPReads: true, forceFullHTTPReads: false },
      true,
    ]
  )
  await page.evaluate((q) => window.spikeQuery(q), "SELECT COUNT(*) FROM 'data.parquet'")

  await reset()
  const leg1 = await page.evaluate(async () => {
    const t0 = performance.now()
    const r = await window._conn.query(
      "SELECT file_row_number AS rn FROM read_parquet('data.parquet', file_row_number=true) ORDER BY num_a LIMIT 100"
    )
    const rns = r.toArray().map((row) => Number(row.rn))
    return { ms: Math.round(performance.now() - t0), rns }
  })
  let s = await stats()
  const leg1Result = {
    ms: leg1.ms,
    requests: s.length,
    transferMB: mb(s.reduce((a, r) => a + r.bytes, 0)),
    distinctRowGroups: new Set(leg1.rns.map((rn) => Math.floor(rn / rowGroup))).size,
  }

  await reset()
  const leg2 = await page.evaluate(
    async (q) => {
      const t0 = performance.now()
      const r = await window._conn.query(q)
      return { ms: Math.round(performance.now() - t0), rows: Number(r.numRows) }
    },
    `SELECT * FROM read_parquet('data.parquet', file_row_number=true) WHERE file_row_number IN (${leg1.rns.join(',')})`
  )
  s = await stats()
  const leg2Result = {
    ms: leg2.ms,
    rows: leg2.rows,
    requests: s.length,
    transferMB: mb(s.reduce((a, r) => a + r.bytes, 0)),
  }

  // Control: 100 consecutive rows — pins that file_row_number pruning works.
  await reset()
  const control = await page.evaluate(async () => {
    const t0 = performance.now()
    const r = await window._conn.query(
      "SELECT * FROM read_parquet('data.parquet', file_row_number=true) WHERE file_row_number BETWEEN 0 AND 99"
    )
    return { ms: Math.round(performance.now() - t0), rows: Number(r.numRows) }
  })
  s = await stats()
  const controlResult = {
    ms: control.ms,
    rows: control.rows,
    requests: s.length,
    transferMB: mb(s.reduce((a, r) => a + r.bytes, 0)),
  }

  results.push({ file, rowGroup, leg1: leg1Result, leg2: leg2Result, control: controlResult })
  console.log(file, JSON.stringify({ leg1: leg1Result, leg2: leg2Result, control: controlResult }))
  await page.close()
}
await browser.close()
server.close()

writeFileSync(join(here, 'results-two-phase.json'), JSON.stringify(results, null, 2))
console.log('written: results-two-phase.json')
