/**
 * Golden-set search quality evaluation (ADR-034, spec §9).
 *
 * Runs every golden query against a live KUKAN instance twice — keyword-only
 * (semantic=false) and hybrid — and reports Recall@10 / nDCG@10 per query and
 * per query type. Exits non-zero when hybrid degrades an `exact` query below
 * the keyword-only baseline (the ADR-034 shipping condition).
 *
 * Usage (from the repo root):
 *   pnpm eval:search [--base http://localhost:3000] [--file <golden-queries.yaml>]
 *   (pnpm forwards flags as-is — do NOT add `--`, parseArgs would reject it)
 *
 * The golden set lives next to this script — copy golden-queries.example.yaml
 * to golden-queries.yaml (gitignored; deployment-specific) and fill it in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { mean, pct, responseDetail } from './eval-utils.js'

const K = 10
// Default golden-set location, independent of the working directory
const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'golden-queries.yaml')

interface GoldenQuery {
  query: string
  type: 'synonym' | 'natural' | 'exact' | 'word'
  relevant: string[]
  /**
   * The resources inside those datasets that answer the query, by name.
   *
   * Optional, and scored separately. A dataset of a hundred tables is found by
   * ranking the dataset, but it is *read* by opening one table — and only the
   * per-resource metrics below say whether the search pointed at the right one.
   */
  relevantResources?: string[]
}

interface Metrics {
  recall: number
  ndcg: number
}

/** How soon the reader is shown a resource that answers the query */
interface ResourceMetrics {
  /** Of the relevant resources, how many appear at all */
  recall: number
  /** 1 / rank of the first relevant one across every resource surfaced */
  mrr: number
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

interface SearchAnswer {
  names: string[]
  /**
   * Every resource the results named, in the order a reader meets them:
   * package by package, and within each, as the search surfaced them.
   */
  resourceNames: string[]
  /** What the search did, as it reports it — 'applied' | 'off' | 'degraded' */
  semantic?: string
}

/**
 * Score the resources against the ones the query is about.
 *
 * Only the names are compared. A resource id is a UUID that differs per
 * deployment, and the golden set is written by hand against a catalogue
 * someone can read.
 */
function evaluateResources(surfaced: string[], relevant: string[]): ResourceMetrics {
  const relevantSet = new Set(relevant)
  const hits = new Set(surfaced.filter((name) => relevantSet.has(name)))
  const first = surfaced.findIndex((name) => relevantSet.has(name))
  return {
    recall: relevant.length === 0 ? 0 : hits.size / relevant.length,
    mrr: first < 0 ? 0 : 1 / (first + 1),
  }
}

async function searchTopNames(
  base: string,
  query: string,
  semantic: boolean
): Promise<SearchAnswer> {
  const params = new URLSearchParams({ q: query, limit: String(K) })
  if (!semantic) params.set('semantic', 'false')
  const url = `${base}/api/v1/packages?${params}`

  // One retry on 5xx — a transient dev-server/backend blip should not abort a whole run
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const body = (await res.json()) as {
        items: Array<{ name: string; matchedResources?: Array<{ name: string }> }>
        semantic?: string
      }
      return {
        names: body.items.map((item) => item.name),
        resourceNames: body.items.flatMap((item) =>
          (item.matchedResources ?? []).map((resource) => resource.name)
        ),
        semantic: body.semantic,
      }
    }
    const detail = await responseDetail(res)
    if (res.status >= 500 && attempt === 0) {
      console.warn(`  retrying "${query}" after ${res.status}: ${detail}`)
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    throw new Error(`search failed (${res.status}) for "${query}": ${detail}`)
  }
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

  type Row = {
    q: GoldenQuery
    keyword: Metrics
    hybrid: Metrics
    keywordRes?: ResourceMetrics
    hybridRes?: ResourceMetrics
    applied: boolean
    state?: string
  }
  const rows: Row[] = []
  for (const q of golden.queries) {
    const [keywordNames, hybridNames] = await Promise.all([
      searchTopNames(base, q.query, false),
      searchTopNames(base, q.query, true),
    ])
    rows.push({
      q,
      keyword: evaluate(keywordNames.names, q.relevant),
      hybrid: evaluate(hybridNames.names, q.relevant),
      ...(q.relevantResources?.length && {
        keywordRes: evaluateResources(keywordNames.resourceNames, q.relevantResources),
        hybridRes: evaluateResources(hybridNames.resourceNames, q.relevantResources),
      }),
      // What the search reports it did. Comparing the two legs' results cannot
      // answer this: they may agree on a query by agreeing, and a vector leg
      // that ran and cleared nothing returns the same empty list as one that
      // never ran.
      //
      // Anything but `applied` fails the run. `off` is a legitimate answer for
      // a deployment with no embedding model, an administrator's kill switch,
      // or a query the fusion declines — and none of those are hybrid search,
      // which is what this run reports on. `undefined` is an API too old to
      // say, which is the same thing: unmeasured.
      applied: hybridNames.semantic === 'applied',
      state: hybridNames.semantic,
    })
  }

  // **The instrument has to know when it measured nothing.** A failed query
  // embedding degrades the search to keyword-only and logs it, which is right —
  // answering with keyword results beats erroring. But the run then reports
  // 38% → 38% as though it had measured hybrid search, and it is a believable
  // number. That happened twice in one afternoon on an expired SSO token, with
  // the logs sitting in the terminal the whole time (ADR-053 §8.1).
  //
  const notApplied = rows.filter((row) => !row.applied)
  if (notApplied.length > 0) {
    const states = [...new Set(notApplied.map((row) => row.state ?? '(not reported)'))]
    console.error(
      `\n✗ the vector leg did not run on ${notApplied.length} of ${rows.length} queries — ${states.join(', ')}.\n` +
        '  The numbers below would be a keyword-only run reported as hybrid, so none are printed.\n' +
        `  degraded: check ${base} for "degrading to keyword-only search" — an expired SSO token does this.\n` +
        '  off: no embedding model, the semantic-search setting is off, or the query declines fusion.'
    )
    process.exit(1)
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
  for (const type of ['synonym', 'natural', 'exact', 'word'] as const) {
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

  // **Ranking the dataset is not the whole job.** A dataset of a hundred tables
  // is opened at one of them, and only this block says whether the search named
  // it. Scored on the queries that declare `relevantResources`; the rest are
  // silent here rather than counted as zero.
  const withResources = rows.filter((row) => row.hybridRes)
  if (withResources.length > 0) {
    console.log(`\nresources surfaced (keyword → hybrid), ${withResources.length} queries:`)
    for (const type of ['synonym', 'natural', 'exact', 'word'] as const) {
      const subset = withResources.filter((row) => row.q.type === type)
      if (subset.length === 0) continue
      const m = (pick: (row: Row) => ResourceMetrics | undefined, key: keyof ResourceMetrics) =>
        mean(subset.map((row) => pick(row)![key]))
      console.log(
        `  ${type.padEnd(8)} recall ${pct(m((r) => r.keywordRes, 'recall'))}→${pct(m((r) => r.hybridRes, 'recall'))}` +
          `   MRR ${m((r) => r.keywordRes, 'mrr').toFixed(2)}→${m((r) => r.hybridRes, 'mrr').toFixed(2)}` +
          `   (${subset.length} queries)`
      )
    }
    const miss = withResources.filter((row) => row.hybridRes!.mrr === 0)
    if (miss.length > 0) {
      console.log(
        `  no relevant resource surfaced at all: ${miss.map((r) => r.q.query).join(', ')}`
      )
    }
  }

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
