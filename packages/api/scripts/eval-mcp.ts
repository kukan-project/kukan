/**
 * How a model uses the MCP server: each golden question is put to Claude Code
 * run headless against a live KUKAN instance's MCP endpoint, with nothing but
 * the KUKAN tools and a neutral system prompt, and the run's tool calls and
 * answer are recorded. Reports, per model and kind of question, whether the
 * answer holds what it should, whether the first turn reached for the shorter
 * way in, how many turns it took, how many searches were not in Japanese (the
 * catalog's language), and the cost.
 *
 * For measuring a change to the tools' descriptions or the server's
 * instructions: run the same golden file before and after, against the same
 * catalog. A model's calls vary run to run, so give each question two or more.
 *
 * Usage (from the repo root; needs the `claude` CLI, logged in):
 *   pnpm eval:mcp [--base http://localhost:3000] [--file <golden-mcp.yaml>] \
 *     [--models haiku,sonnet,opus@high] [--runs 2] [--concurrency 4] [--out <dir>]
 *   (pnpm forwards flags as-is — do NOT add `--`, parseArgs would reject it)
 * `model@effort` sets the effort level for that model's runs. Each run is kept
 * in `--out` as Claude Code's stream-json, to read a run's calls and answer.
 *
 * The golden set lives next to this script — copy golden-mcp.example.yaml to
 * golden-mcp.yaml (gitignored; deployment-specific) and fill it in.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { mean, pct } from './eval-utils.js'

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'golden-mcp.yaml')
/** The shorter way in, by what the question asks for */
const ENTRY = {
  doc: 'search_passages',
  table: 'search_datasets',
  find: 'search_datasets',
} as const
type Kind = keyof typeof ENTRY
const SEARCHES = new Set(['search_passages', 'search_datasets'])
const SYSTEM_PROMPT =
  "You are an assistant. Answer the user's question, using the available tools where they help. Say where the answer comes from."
const JAPANESE = /[぀-ヿ一-鿿]/

interface GoldenQuestion {
  id: string
  kind: Kind
  q: string
  /** A regular expression the answer must match: the figure, the year, the page */
  expect: string
}

interface Run {
  model: string
  question: GoldenQuestion
  /** The tools each turn called, in order */
  turns: string[][]
  searches: { tool: string; q: string }[]
  answer: string
  cost: number
  /** Why the run gave no answer to score: the CLI exited badly, or never reported a result */
  failure?: string
}

/** Run one question once, keeping the stream-json, and read what it did. */
function runOnce(
  question: GoldenQuestion,
  spec: string,
  rep: number,
  mcpConfig: string,
  out: string
): Promise<Run> {
  const [model, effort] = spec.split('@') as [string, string | undefined]
  const file = join(out, `${spec.replace('@', '-')}-${question.id}-${rep}.jsonl`)
  const args = [
    '-p',
    question.q,
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    'mcp__kukan',
    '--system-prompt',
    SYSTEM_PROMPT,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    ...(effort ? ['--effort', effort] : []),
  ]
  return new Promise((resolveRun, reject) => {
    // An empty directory, so no project's CLAUDE.md is read into the run
    const child = spawn('claude', args, { cwd: out, stdio: ['ignore', 'pipe', 'ignore'] })
    const sink = createWriteStream(file)
    child.stdout.pipe(sink)
    child.on('error', reject)
    child.on('close', (code) =>
      sink.end(() => {
        const run = readRun(file, spec, question)
        resolveRun(code === 0 ? run : { ...run, failure: run.failure ?? `exit code ${code}` })
      })
    )
  })
}

function readRun(file: string, model: string, question: GoldenQuestion): Run {
  const turns = new Map<string, string[]>()
  const searches: Run['searches'] = []
  let answer = ''
  let cost = 0
  let finished = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let event: {
      type?: string
      message?: {
        id?: string
        content?: { type?: string; name?: string; input?: { q?: string } }[]
      }
      result?: string
      total_cost_usd?: number
    }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use' || !block.name) continue
        const tool = block.name.split('__').at(-1)!
        const id = event.message?.id ?? String(turns.size)
        turns.set(id, [...(turns.get(id) ?? []), tool])
        if (SEARCHES.has(tool)) searches.push({ tool, q: block.input?.q ?? '' })
      }
    }
    if (event.type === 'result') {
      answer = event.result ?? ''
      cost = event.total_cost_usd ?? 0
      finished = true
    }
  }
  return {
    model,
    question,
    turns: [...turns.values()],
    searches,
    answer,
    cost,
    ...(!finished && { failure: 'no result' }),
  }
}

/** `fn` over `items`, `size` at a time */
async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i]!)
      }
    })
  )
  return results
}

const correct = (run: Run) => new RegExp(run.question.expect).test(run.answer)
const entered = (run: Run) => run.turns[0]?.includes(ENTRY[run.question.kind]) ?? false
const nonJapanese = (run: Run) => run.searches.filter((s) => !JAPANESE.test(s.q)).length
const group = (run: Run) => (JAPANESE.test(run.question.q) ? run.question.kind : 'english')

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:3000' },
      file: { type: 'string', default: DEFAULT_FILE },
      models: { type: 'string', default: 'haiku,sonnet' },
      runs: { type: 'string', default: '2' },
      concurrency: { type: 'string', default: '4' },
      out: { type: 'string' },
    },
  })
  const golden = load(readFileSync(values.file!, 'utf8')) as { questions: GoldenQuestion[] }
  // Absolute: each run's working directory is this one, and the config is given by path
  const out = resolve(values.out ?? join(tmpdir(), `kukan-eval-mcp-${Date.now()}`))
  mkdirSync(out, { recursive: true })
  const mcpConfig = join(out, 'mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { kukan: { type: 'http', url: `${values.base}/api/mcp` } } })
  )

  const jobs = values
    .models!.split(',')
    .flatMap((spec) =>
      golden.questions.flatMap((question) =>
        Array.from({ length: Number(values.runs) }, (_, rep) => ({ spec, question, rep }))
      )
    )
  console.log(`MCP evaluation — ${values.base} (${jobs.length} runs, kept in ${out})\n`)
  const runs = await pooled(jobs, Number(values.concurrency), async ({ spec, question, rep }) => {
    const run = await runOnce(question, spec, rep, mcpConfig, out)
    console.log(
      `${spec.padEnd(10)} ${question.id.padEnd(4)} ${run.failure ? 'FAIL' : correct(run) ? 'OK  ' : 'MISS'} ` +
        `entry ${entered(run) ? 'OK' : 'NG'}  turns ${String(run.turns.length).padStart(2)}  ` +
        `non-JA ${nonJapanese(run)}  ${run.turns.map((t) => t.join('+')).join(' > ')}`
    )
    return run
  })

  // A run that failed says nothing about the model: scored apart, and the run fails
  const failed = runs.filter((r) => r.failure)
  const scored = runs.filter((r) => !r.failure)
  console.log('\nmodel      kind     runs  correct  entry   turns  non-JA  cost')
  const groups = new Map<string, Run[]>()
  for (const run of scored) {
    const key = `${run.model}\t${group(run)}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  for (const [key, subset] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, kind] = key.split('\t') as [string, string]
    console.log(
      `${model.padEnd(10)} ${kind.padEnd(8)} ${String(subset.length).padStart(4)}  ` +
        `${pct(mean(subset.map((r) => +correct(r))))}     ${pct(mean(subset.map((r) => +entered(r))))}  ` +
        `${mean(subset.map((r) => r.turns.length))
          .toFixed(1)
          .padStart(5)}  ` +
        `${String(subset.reduce((n, r) => n + nonJapanese(r), 0)).padStart(6)}  ` +
        `$${subset.reduce((n, r) => n + r.cost, 0).toFixed(2)}`
    )
  }
  const misses = scored.filter((r) => !correct(r))
  if (misses.length > 0) {
    console.log('\nmisses (read the run in the out directory):')
    for (const r of misses)
      console.log(`  ${r.model} ${r.question.id}: ${r.answer.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} run(s) failed and are not scored:`)
    for (const r of failed) console.error(`  ${r.model} ${r.question.id}: ${r.failure}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
