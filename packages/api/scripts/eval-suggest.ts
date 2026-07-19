/**
 * Golden-set quality evaluation for AI metadata suggestions (ADR-040).
 *
 * Runs every golden dataset against a live KUKAN instance's suggest endpoint
 * and scores the responses: required-keyword recall for title/notes,
 * hallucination canaries (forbidden terms that appear nowhere in the
 * material), tag/category precision and recall, URL-slug validity, and
 * description-length distribution. Prints a console summary and writes a
 * markdown report with the full outputs for human review.
 *
 * Intended for comparisons across models, providers, and prompt changes:
 * run the same golden file against each configuration and diff the reports.
 * Exits non-zero when a request fails or a hallucination canary fires.
 *
 * Usage (from the repo root; the target user needs editor rights):
 *   KUKAN_TOKEN=kukan_xxx pnpm eval:suggest \
 *     [-- --base http://localhost:3000] [-- --file <golden-suggest.yaml>] \
 *     [-- --runs 3] [-- --out <report.md>]
 *
 * The golden set lives next to this script — copy golden-suggest.example.yaml
 * to golden-suggest.yaml (gitignored; deployment-specific) and fill it in.
 * Each request counts against the per-user suggestion rate limit (60/h).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import {
  PACKAGE_NAME_PATTERN,
  PACKAGE_NAME_MIN_LENGTH,
  PACKAGE_NAME_MAX_LENGTH,
} from '@kukan/shared'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_FILE = resolve(SCRIPT_DIR, 'golden-suggest.yaml')
const DEFAULT_OUT = resolve(SCRIPT_DIR, 'eval-suggest-report.md')

function isValidName(name: string): boolean {
  return (
    name.length >= PACKAGE_NAME_MIN_LENGTH &&
    name.length <= PACKAGE_NAME_MAX_LENGTH &&
    PACKAGE_NAME_PATTERN.test(name)
  )
}

interface GoldenDataset {
  nameOrId: string
  locale?: 'ja' | 'en'
  /** Terms expected in the suggested title / notes (recall is scored) */
  titleKeywords?: string[]
  notesKeywords?: string[]
  /** Hallucination canaries — terms absent from the material that must not
   *  appear anywhere in the suggestion */
  forbidden?: string[]
  /** Expected tag / category names (precision and recall are scored) */
  expectedTags?: string[]
  expectedGroups?: string[]
  /** Drafts only: assert a valid URL slug is proposed */
  expectName?: boolean
}

interface SuggestResponse {
  suggestion: {
    title: string
    notes: string
    tags: { name: string; isNew: boolean }[]
    /** Absent in responses from older KUKAN versions */
    groups?: string[]
    name?: string
    resources: { id: string; name: string; description: string }[]
  }
  generatedBy: { provider: string; model: string }
  usedResources: string[]
  skippedResources: string[]
}

interface RunResult {
  dataset: GoldenDataset
  run: number
  latencyMs: number
  response: SuggestResponse
  titleRecall: number | null
  notesRecall: number | null
  forbiddenHits: string[]
  tags: { precision: number; recall: number } | null
  groups: { precision: number; recall: number } | null
  nameOk: boolean | null
}

function descLengths(r: RunResult): number[] {
  return r.response.suggestion.resources.map((res) => res.description.length)
}

function recallOf(text: string, keywords: string[] | undefined): number | null {
  if (!keywords?.length) return null
  const haystack = text.toLowerCase()
  const hits = keywords.filter((k) => haystack.includes(k.toLowerCase())).length
  return hits / keywords.length
}

function setScores(
  suggested: string[],
  expected: string[] | undefined
): { precision: number; recall: number } | null {
  if (!expected?.length) return null
  const suggestedSet = new Set(suggested)
  const expectedSet = new Set(expected)
  const overlap = [...suggestedSet].filter((v) => expectedSet.has(v)).length
  return {
    precision: suggestedSet.size === 0 ? 0 : overlap / suggestedSet.size,
    recall: overlap / expectedSet.size,
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function pct(value: number | null): string {
  return value === null ? '  — ' : (value * 100).toFixed(0).padStart(3) + '%'
}

async function requestSuggestion(
  base: string,
  token: string,
  dataset: GoldenDataset
): Promise<{ response: SuggestResponse; latencyMs: number }> {
  const attempt = async () => {
    const startedAt = Date.now()
    const res = await fetch(
      `${base}/api/v1/packages/${encodeURIComponent(dataset.nameOrId)}/suggest-metadata`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ locale: dataset.locale ?? 'ja' }),
      }
    )
    return { res, latencyMs: Date.now() - startedAt }
  }
  const detailOf = (res: Response) =>
    res
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => '')

  let { res, latencyMs } = await attempt()
  if (res.status >= 500) {
    console.warn(`  retrying "${dataset.nameOrId}" after ${res.status}: ${await detailOf(res)}`)
    ;({ res, latencyMs } = await attempt())
  }
  if (res.ok) {
    return { response: (await res.json()) as SuggestResponse, latencyMs }
  }
  const detail = await detailOf(res)
  if (res.status === 429) {
    throw new Error(`rate limit reached (${detail}) — retry after the window resets`)
  }
  throw new Error(`suggest failed (${res.status}) for "${dataset.nameOrId}": ${detail}`)
}

function evaluateRun(
  dataset: GoldenDataset,
  run: number,
  latencyMs: number,
  response: SuggestResponse
): RunResult {
  const s = response.suggestion
  const tagNames = s.tags.map((t) => t.name)
  const everything = [
    s.title,
    s.notes,
    s.name ?? '',
    ...tagNames,
    ...(s.groups ?? []),
    ...s.resources.flatMap((r) => [r.name, r.description]),
  ]
    .join('\n')
    .toLowerCase()
  return {
    dataset,
    run,
    latencyMs,
    response,
    titleRecall: recallOf(s.title, dataset.titleKeywords),
    notesRecall: recallOf(s.notes, dataset.notesKeywords),
    forbiddenHits: (dataset.forbidden ?? []).filter((t) => everything.includes(t.toLowerCase())),
    tags: setScores(tagNames, dataset.expectedTags),
    groups: setScores(s.groups ?? [], dataset.expectedGroups),
    nameOk: dataset.expectName ? !!s.name && isValidName(s.name) : null,
  }
}

function reportRun(r: RunResult): string {
  const s = r.response.suggestion
  const lens = descLengths(r)
  const lines = [
    `### ${r.dataset.nameOrId} — run ${r.run} (${(r.latencyMs / 1000).toFixed(1)}s, ${r.response.generatedBy.provider}/${r.response.generatedBy.model})`,
    '',
    `- title recall ${pct(r.titleRecall)} / notes recall ${pct(r.notesRecall)} / tags P ${pct(r.tags?.precision ?? null)} R ${pct(r.tags?.recall ?? null)} / groups P ${pct(r.groups?.precision ?? null)} R ${pct(r.groups?.recall ?? null)} / name ${r.nameOk === null ? '—' : r.nameOk ? 'ok' : 'NG'}`,
    r.forbiddenHits.length > 0
      ? `- **⚠ hallucination: ${r.forbiddenHits.join(', ')}**`
      : '- hallucination: none',
    `- resources ${s.resources.length} suggested / ${r.response.skippedResources.length} skipped, description length ${lens.length ? `${Math.min(...lens)}–${Math.max(...lens)} (mean ${Math.round(mean(lens))})` : '—'}`,
    '',
    `> **title**: ${s.title}`,
    `> **notes**: ${s.notes.replaceAll('\n', ' ')}`,
    `> **tags**: ${s.tags.map((t) => (t.isNew ? `${t.name}*` : t.name)).join(', ') || '—'}`,
    `> **groups**: ${(s.groups ?? []).join(', ') || '—'}`,
    ...(s.name ? [`> **name**: ${s.name}`] : []),
    ...s.resources.map((res) => `> - ${res.name}: ${res.description.replaceAll('\n', ' ')}`),
    '',
  ]
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:3000' },
      file: { type: 'string', default: DEFAULT_FILE },
      runs: { type: 'string', default: '1' },
      out: { type: 'string', default: DEFAULT_OUT },
    },
  })
  const token = process.env.KUKAN_TOKEN
  if (!token) {
    console.error('KUKAN_TOKEN is required (an API token of a user with editor rights)')
    process.exit(1)
  }
  const base = values.base!
  const runs = Number(values.runs)
  const golden = load(readFileSync(values.file!, 'utf8')) as { datasets: GoldenDataset[] }

  const results: RunResult[] = []
  let failed = 0
  for (const dataset of golden.datasets) {
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`${dataset.nameOrId} run ${run}/${runs} … `)
      try {
        const { response, latencyMs } = await requestSuggestion(base, token, dataset)
        const result = evaluateRun(dataset, run, latencyMs, response)
        results.push(result)
        console.log(
          `${(latencyMs / 1000).toFixed(1)}s  title ${pct(result.titleRecall)}  notes ${pct(result.notesRecall)}` +
            (result.forbiddenHits.length ? `  ⚠ ${result.forbiddenHits.join(',')}` : '')
        )
      } catch (err) {
        failed++
        console.log(`✗ ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  if (results.length > 0) {
    const model = results[0].response.generatedBy
    console.log(
      `\nGolden-set suggestion evaluation — ${base} (${golden.datasets.length} datasets × ${runs} runs, ${model.provider}/${model.model})\n`
    )
    const agg = (pick: (r: RunResult) => number | null) => {
      const vals = results.map(pick).filter((v): v is number => v !== null)
      return vals.length ? mean(vals) : null
    }
    console.log(`  title keyword recall   ${pct(agg((r) => r.titleRecall))}`)
    console.log(`  notes keyword recall   ${pct(agg((r) => r.notesRecall))}`)
    console.log(
      `  tags precision/recall  ${pct(agg((r) => r.tags?.precision ?? null))} / ${pct(agg((r) => r.tags?.recall ?? null))}`
    )
    console.log(
      `  groups precision/recall ${pct(agg((r) => r.groups?.precision ?? null))} / ${pct(agg((r) => r.groups?.recall ?? null))}`
    )
    console.log(
      `  valid slug proposed    ${pct(agg((r) => (r.nameOk === null ? null : Number(r.nameOk))))}`
    )
    const allDescLengths = results.flatMap(descLengths)
    console.log(
      `  description length     mean ${Math.round(mean(allDescLengths))} chars (${results.length} runs)`
    )
    console.log(
      `  latency                mean ${(mean(results.map((r) => r.latencyMs)) / 1000).toFixed(1)}s`
    )

    const header = [
      '# Suggestion golden-set report',
      '',
      `- target: ${base}`,
      `- model: ${model.provider}/${model.model}`,
      `- datasets × runs: ${golden.datasets.length} × ${runs} (${results.length} ok, ${failed} failed)`,
      '',
    ].join('\n')
    writeFileSync(values.out!, header + results.map(reportRun).join('\n'))
    console.log(`\nreport: ${values.out}`)
  }

  const hallucinated = results.filter((r) => r.forbiddenHits.length > 0)
  if (hallucinated.length > 0) {
    console.error(`\n✗ hallucination canaries fired in ${hallucinated.length} run(s)`)
    process.exit(1)
  }
  if (failed > 0) {
    console.error(`\n✗ ${failed} request(s) failed`)
    process.exit(1)
  }
  console.log('\n✓ no hallucination canaries fired')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
