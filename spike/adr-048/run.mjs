// ADR-048 spike driver: runs the measurement page under headless Chromium
// against each (variant x server-mode) combination and prints per-scenario
// request counts, transferred bytes, wall time, and JS heap.
//
// Usage: node spike/adr-048/run.mjs [--quick] [--file rg5000.parquet]
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync } from 'fs'
import { startServer } from './server.mjs'

// Peak-ish memory proxy: total RSS of chromium processes right after the query.
const chromiumRssMB = () => {
  try {
    const out = execFileSync('ps', ['-eo', 'rss,comm'], { encoding: 'utf8' })
    const kb = out
      .split('\n')
      .filter((l) => /chrom|headless/i.test(l))
      .reduce((a, l) => a + (parseInt(l.trim(), 10) || 0), 0)
    return Math.round(kb / 1024)
  } catch {
    return null
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const requireFromWeb = createRequire(join(here, '../../apps/web/package.json'))
const { chromium } = requireFromWeb('@playwright/test')

const QUERY_TIMEOUT_MS = 5 * 60 * 1000

const SCENARIOS = [
  ['metadata', "DESCRIBE SELECT * FROM 'data.parquet'"],
  ['count', "SELECT COUNT(*) FROM 'data.parquet'"],
  ['sort_num', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100"],
  ['sort_str', "SELECT * FROM 'data.parquet' ORDER BY str_city LIMIT 100"],
  ['filter_eq', "SELECT * FROM 'data.parquet' WHERE str_city = 'Osaka' LIMIT 100"],
  ['filter_ilike', "SELECT * FROM 'data.parquet' WHERE str_note ILIKE '%abc%' LIMIT 100"],
  ['page_2', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 100"],
  ['page_3', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 200"],
  ['page_4', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 300"],
  ['page_5', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 400"],
  ['page_6', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 500"],
  ['sort_num_repeat', "SELECT * FROM 'data.parquet' ORDER BY num_a LIMIT 100"],
  // Two-phase pattern: project only the sort column (late materialization by hand).
  ['sort_proj', "SELECT num_a FROM 'data.parquet' ORDER BY num_a LIMIT 100"],
  ['sort_proj_repeat', "SELECT num_a FROM 'data.parquet' ORDER BY num_a LIMIT 100 OFFSET 100"],
]

const quick = process.argv.includes('--quick')
const fileArg = process.argv.indexOf('--file')
const files = fileArg >= 0 ? [process.argv[fileArg + 1]] : ['rg5000.parquet', 'rg100k.parquet']
const modes = quick ? ['ideal'] : ['ideal', 'proxy']

const fetchStats = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/__stats`)
  return res.json()
}
const resetStats = (port) => fetch(`http://127.0.0.1:${port}/__reset`)

const mb = (n) => (n / 1024 / 1024).toFixed(2)

const allResults = []

for (const mode of modes) {
  const { server, port } = await startServer({ mode })
  for (const file of files) {
    for (const [fsLabel, fsConfig, directIO] of [
      ['default', null, false],
      [
        'range',
        { reliableHeadRequests: true, allowFullHTTPReads: true, forceFullHTTPReads: false },
        true,
      ],
    ]) {
      const browser = await chromium.launch()
      const page = await browser.newPage()
      page.setDefaultTimeout(QUERY_TIMEOUT_MS)
      await page.goto(`http://127.0.0.1:${port}/page.html`)

      await resetStats(port)
      let initOk = true
      let initErr = null
      try {
        await page.evaluate(
          ([u, f, d]) => window.spikeInit(u, f, d),
          [`http://127.0.0.1:${port}/data/${file}`, fsConfig, directIO]
        )
      } catch (e) {
        initOk = false
        initErr = String(e).slice(0, 300)
      }
      const initStats = await fetchStats(port)
      const initReqs = initStats.requests.filter((r) => r.path.startsWith('/data/'))
      const initBytes = initReqs.reduce((a, r) => a + r.bytes, 0)
      const run = {
        mode,
        file,
        fsLabel,
        initBytes,
        initRequests: initReqs.slice(0, 30),
        initOk,
        initErr,
        scenarios: [],
      }
      console.log(
        `\n=== mode=${mode} file=${file} fs=${fsLabel} init=${initOk ? 'ok' : 'FAILED'} initTransfer=${mb(initBytes)}MB`
      )
      if (initErr) console.log(`    init error: ${initErr}`)

      if (initOk) {
        for (const [name, sql] of SCENARIOS) {
          await resetStats(port)
          let r
          try {
            r = await page.evaluate((q) => window.spikeQuery(q), sql)
          } catch (e) {
            r = { ms: -1, rows: -1, heap: null, error: String(e).slice(0, 200) }
          }
          let workerHeap = null
          try {
            const wk = page.workers()[0]
            if (wk)
              workerHeap = await wk.evaluate(() => performance?.memory?.usedJSHeapSize ?? null)
          } catch {
            /* worker heap is best-effort */
          }
          const s = await fetchStats(port)
          const dataReqs = s.requests.filter((rq) => rq.path.startsWith('/data/'))
          const bytes = dataReqs.reduce((a, rq) => a + rq.bytes, 0)
          const st416 = dataReqs.filter((rq) => rq.status === 416).length
          const row = {
            name,
            ms: r.ms,
            rows: Number(r.rows),
            requests: dataReqs.length,
            bytes,
            status416: st416,
            heapMB: r.heap ? Math.round(r.heap / 1024 / 1024) : null,
            workerHeapMB: workerHeap ? Math.round(workerHeap / 1024 / 1024) : null,
            rssMB: chromiumRssMB(),
            error: r.error ?? null,
            sample: dataReqs.slice(0, 20),
          }
          run.scenarios.push(row)
          console.log(
            `  ${name.padEnd(16)} ${String(r.ms).padStart(7)}ms  reqs=${String(dataReqs.length).padStart(4)}  transfer=${mb(bytes).padStart(9)}MB  416s=${st416}  rss=${row.rssMB ?? '-'}MB${r.error ? '  ERR ' + r.error : ''}`
          )
        }
      }
      allResults.push(run)
      await browser.close()
    }
  }
  server.close()
}

const out = join(here, 'results.json')
writeFileSync(out, JSON.stringify(allResults, null, 2))
console.log(`\nresults written to ${out}`)
