'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { ImageIcon } from 'lucide-react'
import {
  TEXT_PREVIEW_LIMIT_MB,
  type DocumentText,
  type DocumentTextBlock,
  type DocumentTextLoc,
} from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { PreviewSkeleton, PreviewError } from './resource-preview'

interface DocumentTextPreviewProps {
  resourceId: string
}

/** The blocks of one page, slide or sheet, or of a document with none. */
interface Unit {
  key: string
  loc: DocumentTextLoc
  blocks: { block: DocumentTextBlock; index: number }[]
}

/** An entry of the outline: a heading path where it first appears. */
interface OutlineEntry {
  title: string
  depth: number
  index: number
}

/**
 * A document's extracted text, a page (slide, sheet) at a time, with the
 * headings the file marks and the figures it holds — what extraction made of
 * the file, beside the original. The outline lists the headings where the file
 * has any, and the pages where it has none.
 */
export function DocumentTextPreview({ resourceId }: DocumentTextPreviewProps) {
  const t = useTranslations('resource')
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'none' }
    | { kind: 'error' }
    | { kind: 'ready'; text: DocumentText }
  >({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(
          `/api/v1/resources/${encodeURIComponent(resourceId)}/document-text`
        )
        if (res.status === 404) {
          if (!cancelled) setState({ kind: 'none' })
          return
        }
        if (!res.ok) throw new Error()
        const text = (await res.json()) as DocumentText
        if (!cancelled) setState({ kind: 'ready', text })
      } catch {
        if (!cancelled) setState({ kind: 'error' })
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const text = state.kind === 'ready' ? state.text : null
  const units = useMemo(() => unitsOf(text?.blocks ?? []), [text])
  const outline = useMemo(() => outlineOf(text?.blocks ?? []), [text])
  const repeats = useMemo(() => digestCounts(text?.blocks ?? []), [text])

  if (state.kind === 'loading') return <PreviewSkeleton />
  if (state.kind === 'error') return <PreviewError />
  if (!text) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('documentTextNone')}
        </CardContent>
      </Card>
    )
  }

  const figures = text.blocks.filter((b) => b.figure).length
  const blank = text.blocks.filter((b) => b.unreadable === 'no-text').length
  // Pages, not blocks: a long page is written as several
  const unreadable = new Set(
    text.blocks.filter((b) => b.unreadable === 'unmapped-fonts').map((b) => b.loc.page)
  ).size
  const partly = new Set(
    text.blocks.filter((b) => b.unmappedChars && !b.unreadable).map((b) => b.loc.page)
  ).size
  const labelled = units.map((unit) => ({ ...unit, label: unitLabel(unit.loc, t) }))
  const byHeadings = outline.length > 0
  const navLabel = t(byHeadings ? 'documentTextOutline' : unitsLabel(units))
  const nav = byHeadings
    ? outline
    : labelled
        .filter((unit) => unit.label)
        .map((unit) => ({ title: unit.label, depth: 0, index: unit.blocks[0].index }))

  const jump = (index: number) =>
    document.getElementById(blockId(resourceId, index))?.scrollIntoView({ block: 'start' })

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          {t('documentTextSummary', { units: units.length, figures, blank })}
          {unreadable > 0 && ` · ${t('documentTextUnreadableCount', { count: unreadable })}`}
          {partly > 0 && ` · ${t('documentTextPartlyUnreadableCount', { count: partly })}`}
        </p>
        <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
          {nav.length > 0 && (
            <nav
              aria-label={navLabel}
              className="max-h-[600px] overflow-y-auto border-b pb-2 text-sm md:border-r md:border-b-0 md:pr-2 md:pb-0"
            >
              <p className="mb-1 text-xs font-medium text-muted-foreground">{navLabel}</p>
              <ul className="space-y-0.5">
                {nav.map((entry) => (
                  <li
                    key={`${entry.index}:${entry.depth}`}
                    style={{ paddingLeft: `${entry.depth * 0.75}rem` }}
                  >
                    <button
                      type="button"
                      className="w-full truncate text-left hover:underline"
                      title={entry.title}
                      onClick={() => jump(entry.index)}
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div className="max-h-[600px] space-y-4 overflow-y-auto md:col-start-2">
            {labelled.map((unit) => (
              <section key={unit.key || 'document'} className="space-y-2">
                {unit.label && (
                  <h3 className="sticky top-0 flex items-baseline gap-2 border-b bg-background py-1 text-sm font-semibold">
                    {unit.label}
                    {unit.loc.page !== undefined && (
                      <a
                        className="text-xs font-normal text-muted-foreground hover:underline"
                        href={`/api/v1/resources/${encodeURIComponent(resourceId)}/preview#page=${unit.loc.page}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('documentTextOpenPage')}
                      </a>
                    )}
                  </h3>
                )}
                {unit.blocks.map(({ block, index }, i) => (
                  <Fragment key={index}>
                    {headingsChanged(unit.blocks[i - 1]?.block, block) && (
                      <p className="text-xs font-medium text-primary">
                        {block.headings!.join(' › ')}
                      </p>
                    )}
                    <BlockView
                      id={blockId(resourceId, index)}
                      block={block}
                      repeated={block.figure?.digest ? repeats.get(block.figure.digest) : undefined}
                    />
                  </Fragment>
                ))}
              </section>
            ))}
          </div>
        </div>
        {text.truncated && (
          <p className="text-xs text-muted-foreground">
            {t('previewTruncated', { mb: TEXT_PREVIEW_LIMIT_MB })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function BlockView({
  id,
  block,
  repeated,
}: {
  id: string
  block: DocumentTextBlock
  repeated?: number
}) {
  const t = useTranslations('resource')
  if (block.figure) {
    const { width, height, ref } = block.figure
    return (
      <div id={id} className="flex items-start gap-2 rounded border border-dashed p-2 text-xs">
        <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-muted-foreground">
            {t('documentTextFigure')}
            {width !== undefined &&
              height !== undefined &&
              ` · ${t('documentTextFigureSize', { width, height })}`}
            {` · ${ref}`}
            {repeated !== undefined &&
              repeated > 1 &&
              ` · ${t('documentTextFigureRepeated', { count: repeated })}`}
          </p>
          {block.text && <p>{block.text}</p>}
        </div>
      </div>
    )
  }
  if (block.unreadable === 'no-text') {
    return (
      <p id={id} className="rounded bg-muted p-2 text-xs text-muted-foreground">
        {t('documentTextNoTextLayer')}
      </p>
    )
  }
  if (block.unreadable === 'unmapped-fonts') {
    return (
      <div id={id} className="space-y-1">
        <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
          {t('documentTextUnreadable')}
        </p>
        {block.text.trim() && (
          <pre className="font-sans text-sm whitespace-pre-wrap">{block.text}</pre>
        )}
      </div>
    )
  }
  if (block.unmappedChars) {
    return (
      <div id={id} className="space-y-1">
        <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
          {t('documentTextPartlyUnreadable', { count: block.unmappedChars })}
        </p>
        <pre className="font-sans text-sm whitespace-pre-wrap">{block.text}</pre>
      </div>
    )
  }
  const rows = block.loc.rows
  if (rows) {
    // A line per row of the sheet, numbered as the sheet numbers it
    return (
      <div id={id}>
        {block.text.split('\n').map((line, i) => (
          <div key={i} className="flex gap-2">
            <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
              {rows[i]}
            </span>
            <pre className="min-w-0 flex-1 font-sans text-sm whitespace-pre-wrap">{line}</pre>
          </div>
        ))}
      </div>
    )
  }
  return (
    <pre id={id} className="font-sans text-sm whitespace-pre-wrap">
      {block.text}
    </pre>
  )
}

function blockId(resourceId: string, index: number): string {
  return `document-text-${resourceId}-${index}`
}

/** Consecutive blocks of one page, slide or sheet; rows of a sheet stay together. */
function unitsOf(blocks: DocumentTextBlock[]): Unit[] {
  const units: Unit[] = []
  blocks.forEach((block, index) => {
    const key = unitKey(block.loc)
    const last = units[units.length - 1]
    if (last && last.key === key) last.blocks.push({ block, index })
    else units.push({ key, loc: block.loc, blocks: [{ block, index }] })
  })
  return units
}

function unitKey(loc: DocumentTextLoc): string {
  if (loc.page !== undefined) return `page:${loc.page}`
  if (loc.slide !== undefined) return `slide:${loc.slide}`
  if (loc.sheet !== undefined) return `sheet:${loc.sheet}`
  return ''
}

/** What the units are, by the kind every one of them is; pages where they are not all one. */
function unitsLabel(units: Unit[]) {
  const kinds = new Set(units.map((unit) => unitKey(unit.loc).split(':')[0]))
  if (kinds.size === 1 && kinds.has('sheet')) return 'documentTextSheets'
  if (kinds.size === 1 && kinds.has('slide')) return 'documentTextSlides'
  return 'documentTextPages'
}

function unitLabel(loc: DocumentTextLoc, t: ReturnType<typeof useTranslations>): string {
  if (loc.page !== undefined) {
    return loc.label
      ? t('documentTextPageLabelled', { page: loc.page, label: loc.label })
      : t('documentTextPage', { page: loc.page })
  }
  if (loc.slide !== undefined) return t('documentTextSlide', { slide: loc.slide })
  if (loc.sheet === undefined) return ''
  return loc.sheetName !== undefined
    ? t('documentTextSheet', { sheet: loc.sheetName })
    : t('documentTextSheetNumber', { sheet: loc.sheet })
}

/** Each heading where the path first reaches it, nested by its depth in the path. */
function outlineOf(blocks: DocumentTextBlock[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const seen = new Set<string>()
  blocks.forEach((block, index) => {
    block.headings?.forEach((title, depth) => {
      const path = JSON.stringify(block.headings!.slice(0, depth + 1))
      if (seen.has(path)) return
      seen.add(path)
      entries.push({ title, depth, index })
    })
  })
  return entries
}

function headingsChanged(previous: DocumentTextBlock | undefined, block: DocumentTextBlock) {
  if (!block.headings?.length || block.figure) return false
  return JSON.stringify(previous?.headings) !== JSON.stringify(block.headings)
}

/** How many times each picture appears: a page decoration appears on every page. */
function digestCounts(blocks: DocumentTextBlock[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    const digest = block.figure?.digest
    if (digest) counts.set(digest, (counts.get(digest) ?? 0) + 1)
  }
  return counts
}
