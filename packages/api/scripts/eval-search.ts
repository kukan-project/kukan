/**
 * Golden-set search quality evaluation (ADR-034, spec §9).
 *
 * Runs every golden query against a live KUKAN instance twice — keyword-only
 * (semantic=false) and hybrid — and reports Recall@10 / nDCG@10 per query and
 * per query type. Exits non-zero when hybrid degrades an `exact` query below
 * the keyword-only baseline (the ADR-034 shipping condition).
 *
 * Usage (from the repo root):
 *   pnpm eval:search [-- --base http://localhost:3000] [-- --file <golden-queries.yaml>]
 *
 * The golden set lives next to this script — copy golden-queries.example.yaml
 * to golden-queries.yaml (gitignored; deployment-specific) and fill it in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'

const K = 10
// Default golden-set location, independent of the working directory
const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'golden-queries.yaml')

interface GoldenQuery {
  query: string
  type: 'synonym' | 'natural' | 'exact'
  relevant: string[]
}

interface Metrics {
  recall: number
  ndcg: number
}

function evaluate(topNames: string[], relevant: string[]): Metrics {
  const relevantSet = new Set(relevant)
  const hits = topNames.filter((name) => relevantSet.has(name)).length
  const recall = relevant.length === 0 ? 0 : hits / Math.min(relevant.length, K)

  let dcg = 0
  topNames.forEach((name, index) => {
    if (relevantSet.has(name)) dcg += 1 / Math.log2(index + 2)
  })
  let idcg = 0
  for (let i = 0; i < Math.min(relevant.length, K); i++) idcg += 1 / Math.log2(i + 2)
  const ndcg = idcg === 0 ? 0 : dcg / idcg

  return { recall, ndcg }
}

async function searchTopNames(base: string, query: string, semantic: boolean): Promise<string[]> {
  const params = new URLSearchParams({ q: query, limit: String(K) })
  if (!semantic) params.set('semantic', 'false')
  const url = `${base}/api/v1/packages?${params}`

  // One retry on 5xx — a transient dev-server/backend blip should not abort a whole run
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const body = (await res.json()) as { items: Array<{ name: string }> }
      return body.items.map((item) => item.name)
    }
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    if (res.status >= 500 && attempt === 0) {
      console.warn(`  retrying "${query}" after ${res.status}: ${detail}`)
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    throw new Error(`search failed (${res.status}) for "${query}": ${detail}`)
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function pct(value: number): string {
  return (value * 100).toFixed(0).padStart(3) + '%'
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:3000' },
      file: { type: 'string', default: DEFAULT_FILE },
    },
  })
  const base = values.base!
  const golden = load(readFileSync(values.file!, 'utf8')) as { queries: GoldenQuery[] }

  type Row = { q: GoldenQuery; keyword: Metrics; hybrid: Metrics }
  const rows: Row[] = []
  for (const q of golden.queries) {
    const [keywordNames, hybridNames] = await Promise.all([
      searchTopNames(base, q.query, false),
      searchTopNames(base, q.query, true),
    ])
    rows.push({
      q,
      keyword: evaluate(keywordNames, q.relevant),
      hybrid: evaluate(hybridNames, q.relevant),
    })
  }

  console.log(`\nGolden-set evaluation — ${base} (${rows.length} queries, k=${K})\n`)
  console.log('type     R@10 kw→hy   nDCG kw→hy   query')
  for (const { q, keyword, hybrid } of rows) {
    const mark = q.type === 'exact' && hybrid.ndcg < keyword.ndcg ? '  ⚠ exact regression' : ''
    console.log(
      `${q.type.padEnd(8)} ${pct(keyword.recall)}→${pct(hybrid.recall)}   ${pct(keyword.ndcg)}→${pct(hybrid.ndcg)}   ${q.query}${mark}`
    )
  }

  console.log('\nmeans by type (keyword → hybrid):')
  for (const type of ['synonym', 'natural', 'exact'] as const) {
    const subset = rows.filter((row) => row.q.type === type)
    if (subset.length === 0) continue
    const kw = {
      r: mean(subset.map((s) => s.keyword.recall)),
      n: mean(subset.map((s) => s.keyword.ndcg)),
    }
    const hy = {
      r: mean(subset.map((s) => s.hybrid.recall)),
      n: mean(subset.map((s) => s.hybrid.ndcg)),
    }
    console.log(
      `  ${type.padEnd(8)} R@10 ${pct(kw.r)}→${pct(hy.r)}   nDCG ${pct(kw.n)}→${pct(hy.n)}   (${subset.length} queries)`
    )
  }
  const overallKw = mean(rows.map((row) => row.keyword.ndcg))
  const overallHy = mean(rows.map((row) => row.hybrid.ndcg))
  console.log(`  ${'overall'.padEnd(8)} nDCG ${pct(overallKw)}→${pct(overallHy)}`)

  // Shipping condition (ADR-034 決定8): hybrid must not degrade exact-match queries
  const regressions = rows.filter(
    (row) => row.q.type === 'exact' && row.hybrid.ndcg < row.keyword.ndcg
  )
  if (regressions.length > 0) {
    console.error(
      `\n✗ ${regressions.length} exact-match ${regressions.length === 1 ? 'query' : 'queries'} degraded by hybrid search`
    )
    process.exit(1)
  }
  console.log('\n✓ no exact-match regression')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
