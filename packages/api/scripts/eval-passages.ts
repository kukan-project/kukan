/**
 * Golden-set evaluation of passage search (ADR-061 §決定 4).
 *
 * Runs every golden query against a live KUKAN instance, keyword-only and
 * hybrid, and asks of the passages returned whether one is a right one: in the
 * resource named, on the pages given, holding the text given. Reports Hit@1,
 * Hit@5 and MRR@10 per query type, and for each query no right passage came
 * back for, which stage lost it — the first, where the resource itself was not
 * found, or the second, where it was and the passage was not.
 *
 * Usage (from the repo root):
 *   pnpm eval:passages [--base http://localhost:3000] [--file <golden-passages.yaml>]
 *   (pnpm forwards flags as-is — do NOT add `--`, parseArgs would reject it)
 *
 * The golden set lives next to this script — copy golden-passages.example.yaml
 * to golden-passages.yaml (gitignored; deployment-specific) and fill it in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { getJson, mean, pct } from './eval-utils.js'

const K = 10
const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'golden-passages.yaml')
const QUERY_TYPES = ['exact', 'natural', 'synonym', 'word'] as const

interface RelevantPassage {
  /** The resource's name, as the catalogue shows it */
  resource: string
  /** The pages (slides, sheets) the passage is on, first and last; any page where absent */
  pages?: [number, number]
  /** Text the passage holds; compared with width and spaces evened out */
  contains?: string
}

interface GoldenPassageQuery {
  query: string
  type: (typeof QUERY_TYPES)[number]
  relevant: RelevantPassage[]
}

interface ReturnedPassage {
  resourceName: string | null
  text: string
  first: { page?: number; slide?: number; sheet?: number }
  last: { page?: number; slide?: number; sheet?: number }
}

interface Answer {
  passages: ReturnedPassage[]
  via: string
  semantic: string
}

const unit = (loc: ReturnedPassage['first']) => loc.page ?? loc.slide ?? loc.sheet
const fold = (text: string) => text.normalize('NFKC').replace(/\s+/g, '')

function isRight(passage: ReturnedPassage, relevant: RelevantPassage): boolean {
  if ((passage.resourceName ?? '').trim() !== relevant.resource.trim()) return false
  if (relevant.pages) {
    const [from, to] = relevant.pages
    const first = unit(passage.first)
    const last = unit(passage.last) ?? first
    if (first === undefined || last === undefined || last < from || first > to) return false
  }
  return !relevant.contains || fold(passage.text).includes(fold(relevant.contains))
}

async function searchPassages(base: string, q: string, semantic: boolean): Promise<Answer> {
  const params = new URLSearchParams({
    q,
    k: String(K),
    per_resource: '3',
    max_chars: '32000',
    semantic: String(semantic),
  })
  return getJson<Answer>(`${base}/api/v1/passages?${params}`)
}

/** The resources the first stage found: those the dataset search names */
async function firstStage(base: string, q: string, semantic: boolean): Promise<string[]> {
  const params = new URLSearchParams({ q, limit: '10' })
  if (!semantic) params.set('semantic', 'false')
  const body = await getJson<{ items: { matchedResources?: { name?: string }[] }[] }>(
    `${base}/api/v1/packages?${params}`
  )
  return body.items.flatMap((item) =>
    (item.matchedResources ?? []).map((r) => (r.name ?? '').trim())
  )
}

interface Scored {
  /** 1-based rank of the first right passage; 0 where none came back */
  rank: number
  /** Where none did: whether the first stage found a resource named */
  lost?: 'first stage' | 'second stage'
  top: string
}

async function score(
  base: string,
  q: GoldenPassageQuery,
  semantic: boolean
): Promise<Scored & { answer: Answer }> {
  const answer = await searchPassages(base, q.query, semantic)
  const index = answer.passages.findIndex((p) => q.relevant.some((r) => isRight(p, r)))
  const top = answer.passages[0]
  const topText = top ? `${top.resourceName} p${unit(top.first) ?? '-'}` : '(none)'
  if (index >= 0) return { rank: index + 1, top: topText, answer }
  const found = new Set(await firstStage(base, q.query, semantic))
  const lost = q.relevant.some((r) => found.has(r.resource.trim())) ? 'second stage' : 'first stage'
  return { rank: 0, lost, top: topText, answer }
}

const hitAt = (rank: number, n: number) => (rank > 0 && rank <= n ? 1 : 0)
const rr = (rank: number) => (rank > 0 ? 1 / rank : 0)

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:3000' },
      file: { type: 'string', default: DEFAULT_FILE },
    },
  })
  const base = values.base!
  const golden = load(readFileSync(values.file!, 'utf8')) as { queries: GoldenPassageQuery[] }

  const rows: { q: GoldenPassageQuery; keyword: Scored; hybrid: Scored & { answer: Answer } }[] = []
  for (const q of golden.queries) {
    const [keyword, hybrid] = await Promise.all([score(base, q, false), score(base, q, true)])
    rows.push({ q, keyword, hybrid })
  }

  const vias = [...new Set(rows.map((r) => r.hybrid.answer.via))].join(', ')
  const states = [...new Set(rows.map((r) => r.hybrid.answer.semantic))].join(', ')
  console.log(
    `\nPassage evaluation — ${base} (${rows.length} queries, k=${K}; passages cut by: ${vias}; vector leg: ${states})\n`
  )
  console.log('type     rank kw→hy   top passage (hybrid)                       query')
  for (const { q, keyword, hybrid } of rows) {
    const r = (s: Scored) => (s.rank > 0 ? String(s.rank) : '–').padStart(2)
    console.log(
      `${q.type.padEnd(8)} ${r(keyword)} → ${r(hybrid)}    ${(hybrid.top ?? '').slice(0, 40).padEnd(42)} ${q.query}`
    )
  }

  console.log('\nmeans by type (keyword → hybrid):')
  for (const type of [...QUERY_TYPES, 'overall'] as const) {
    const subset = type === 'overall' ? rows : rows.filter((row) => row.q.type === type)
    if (subset.length === 0) continue
    const m = (pick: (row: (typeof rows)[number]) => number) => pct(mean(subset.map(pick)))
    console.log(
      `  ${type.padEnd(8)} Hit@1 ${m((r) => hitAt(r.keyword.rank, 1))}→${m((r) => hitAt(r.hybrid.rank, 1))}` +
        `   Hit@5 ${m((r) => hitAt(r.keyword.rank, 5))}→${m((r) => hitAt(r.hybrid.rank, 5))}` +
        `   MRR ${mean(subset.map((r) => rr(r.keyword.rank))).toFixed(2)}→${mean(subset.map((r) => rr(r.hybrid.rank))).toFixed(2)}` +
        `   (${subset.length} queries)`
    )
  }

  // Which stage lost each miss: the first is the dataset search's, the second
  // this feature's own. A miss to judge by hand besides — whether the words
  // would have matched, rephrased — is what decides passage embeddings (ADR-061 §決定 5).
  const misses = rows.filter((row) => row.hybrid.rank === 0)
  if (misses.length > 0) {
    console.log('\nmisses (hybrid):')
    for (const { q, hybrid } of misses) console.log(`  [${hybrid.lost}] ${q.query}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
