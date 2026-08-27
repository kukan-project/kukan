'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Code2, Copy, Loader2, Play } from 'lucide-react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@kukan/ui'
import type { ResourceSchema } from '@kukan/shared'
import { clientFetch, problemDetail } from '@/lib/client-api'
import { quoteColumn } from '@/hooks/duckdb-sql'
import { highlight, useHighlighter, type HighlightLang } from '@/hooks/use-shiki'

/** Rendering cap for the result table; the full payload is summarized by rowCount. */
const MAX_RENDERED_ROWS = 500

interface DataApiDialogProps {
  resourceId: string
  schema: ResourceSchema
}

interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
}

function CopyButton({ text }: { text: string }) {
  const t = useTranslations('resource')
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const label = copied ? t('dataApiCopied') : t('dataApiCopy')
  return (
    <Button
      variant="ghost"
      size="icon"
      className="absolute top-1 right-1 h-7 w-7"
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

/** Shared text metrics for plain, highlighted, and mirrored code blocks. */
const CODE_BLOCK_CLASS = 'p-3 pr-10 font-mono text-xs'

function CodeBlock({ code, lang }: { code: string; lang?: HighlightLang }) {
  const highlighter = useHighlighter()
  return (
    <div className="relative rounded-md border bg-muted">
      {highlighter && lang ? (
        // Shiki escapes the code it wraps; nothing user-controlled reaches
        // this HTML unescaped.
        <div
          className={cn(CODE_BLOCK_CLASS, 'overflow-x-auto')}
          dangerouslySetInnerHTML={{ __html: highlight(highlighter, code, lang) }}
        />
      ) : (
        <pre className={cn(CODE_BLOCK_CLASS, 'overflow-x-auto')}>{code}</pre>
      )}
      <CopyButton text={code} />
    </div>
  )
}

/** Nested values (DuckDB LIST/STRUCT/MAP) arrive as arrays/objects; render as JSON. */
function formatJsonCell(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

// Memoized so typing in the SQL editor doesn't re-reconcile up to 500 rows
// of already-rendered result on every keystroke.
const ResultTable = memo(function ResultTable({ result }: { result: QueryResult }) {
  const t = useTranslations('resource')
  return (
    <>
      <div className="max-h-64 overflow-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 border-b bg-muted">
            <tr>
              {result.columns.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="px-2 py-1.5 text-left font-medium whitespace-nowrap"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, MAX_RENDERED_ROWS).map((row, i) => (
              <tr key={i} className="border-b last:border-b-0">
                {result.columns.map((col) => (
                  <td key={col} className="px-2 py-1 whitespace-nowrap">
                    {row[col] === null || row[col] === undefined ? (
                      <span className="text-muted-foreground">&mdash;</span>
                    ) : (
                      formatJsonCell(row[col])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('dataApiResultMeta', { rows: result.rowCount, ms: result.elapsedMs })}
        {result.truncated && ` ${t('dataApiResultTruncated')}`}
        {result.rows.length > MAX_RENDERED_ROWS &&
          ` ${t('dataApiResultShown', { shown: MAX_RENDERED_ROWS })}`}
      </p>
    </>
  )
})

/**
 * One runnable SQL example — the run button POSTs to the real /query endpoint,
 * so the example doubles as a live demo of exactly what an API client gets.
 */
function SqlExample({
  resourceId,
  label,
  initialSql,
}: {
  resourceId: string
  label: string
  initialSql: string
}) {
  const t = useTranslations('resource')
  const highlighter = useHighlighter()
  const highlightRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [sql, setSql] = useState(initialSql)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Closing the dialog unmounts this component; abort the in-flight query so
  // it doesn't keep occupying the server's query slot (concurrency is capped).
  useEffect(() => () => abortRef.current?.abort(), [])

  // Memoized so unrelated state changes (running, result) don't re-tokenize —
  // a pasted max-length query costs ~20ms per highlight() call.
  const highlightedSql = useMemo(
    () => (highlighter ? highlight(highlighter, sql, 'sql', { focusable: false }) : null),
    [highlighter, sql]
  )

  async function run() {
    setRunning(true)
    setError(null)
    abortRef.current = new AbortController()
    try {
      const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
        signal: abortRef.current.signal,
      })
      if (!res.ok) {
        setResult(null)
        setError((await problemDetail(res)) ?? t('dataApiRunFailed'))
        return
      }
      setResult((await res.json()) as QueryResult)
    } catch {
      setResult(null)
      setError(t('dataApiRunFailed'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Button variant="outline" size="sm" onClick={run} disabled={running || !sql.trim()}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {t('dataApiRun')}
        </Button>
      </div>
      <div className="relative">
        {/* Highlighted mirror behind a transparent-text textarea: the textarea
            keeps editing/caret/selection, the mirror provides the colors. Its
            border-transparent matches the textarea's border so text aligns. */}
        {highlightedSql && (
          <div
            ref={highlightRef}
            aria-hidden
            className={cn(
              CODE_BLOCK_CLASS,
              'pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent'
            )}
            dangerouslySetInnerHTML={{ __html: highlightedSql }}
          />
        )}
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onScroll={(e) => {
            const mirror = highlightRef.current
            if (mirror) {
              mirror.scrollLeft = e.currentTarget.scrollLeft
              mirror.scrollTop = e.currentTarget.scrollTop
            }
          }}
          rows={Math.min(sql.split('\n').length, 20)}
          wrap="off"
          spellCheck={false}
          aria-label={label}
          className={cn(
            'relative min-h-0 resize-y p-3 pr-10 font-mono text-xs md:text-xs',
            highlightedSql && 'text-transparent caret-foreground'
          )}
        />
        <CopyButton text={sql} />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {/* Always mounted: a polite live region must exist before its content
          changes for the announcement to fire reliably. */}
      <div role="status" className={result ? 'flex flex-col gap-1' : undefined}>
        {result && <ResultTable result={result} />}
      </div>
    </div>
  )
}

/**
 * "Data API" button + dialog in the spirit of CKAN's Data API panel: endpoint
 * URLs, ready-to-paste curl / fetch examples, and runnable SQL examples built
 * from the resource's actual column names (ADR-032).
 */
export function DataApiDialog({ resourceId, schema }: DataApiDialogProps) {
  const t = useTranslations('resource')

  // Rendered during SSR too (the trigger button), but the URLs only appear
  // inside the dialog content, which mounts client-side on open.
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const schemaUrl = `${origin}/api/v1/resources/${encodeURIComponent(resourceId)}/schema`
  const queryUrl = `${origin}/api/v1/resources/${encodeURIComponent(resourceId)}/query`

  const basicSql = 'SELECT * FROM data LIMIT 10'
  const firstColumn = quoteColumn(schema.columns[0].name)
  const aggregateSql = `SELECT ${firstColumn}, COUNT(*) AS count\nFROM data\nGROUP BY ${firstColumn}\nORDER BY count DESC\nLIMIT 10`

  const curlExample = [
    `curl '${schemaUrl}'`,
    '',
    `curl -X POST '${queryUrl}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"sql": "${basicSql}"}'`,
  ].join('\n')

  const fetchExample = [
    `const res = await fetch('${queryUrl}', {`,
    `  method: 'POST',`,
    `  headers: { 'Content-Type': 'application/json' },`,
    `  body: JSON.stringify({ sql: '${basicSql}' }),`,
    `})`,
    `const { columns, rows } = await res.json()`,
  ].join('\n')

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Code2 className="size-4" />
          {t('dataApi')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('dataApi')}</DialogTitle>
          <DialogDescription>{t('dataApiDescription')}</DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, and without it the code blocks'
            long lines widen the dialog instead of scrolling inside the pre */}
        <div className="flex min-w-0 flex-col gap-5 text-sm">
          <section className="flex flex-col gap-2">
            <h4 className="font-medium">{t('dataApiEndpoints')}</h4>
            <p className="text-xs text-muted-foreground">{t('dataApiSchemaEndpoint')}</p>
            <CodeBlock code={`GET ${schemaUrl}`} />
            <p className="text-xs text-muted-foreground">{t('dataApiQueryEndpoint')}</p>
            <CodeBlock code={`POST ${queryUrl}`} />
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="font-medium">{t('dataApiUsage')}</h4>
            <Tabs defaultValue="curl">
              <TabsList>
                <TabsTrigger value="curl">curl</TabsTrigger>
                <TabsTrigger value="js">JavaScript</TabsTrigger>
              </TabsList>
              <TabsContent value="curl">
                <CodeBlock code={curlExample} lang="bash" />
              </TabsContent>
              <TabsContent value="js">
                <CodeBlock code={fetchExample} lang="javascript" />
              </TabsContent>
            </Tabs>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <h4 className="font-medium">{t('dataApiSqlExamples')}</h4>
              <span className="text-xs text-muted-foreground">{t('dataApiSqlEditableHint')}</span>
            </div>
            <SqlExample
              resourceId={resourceId}
              label={t('dataApiSqlBasic')}
              initialSql={basicSql}
            />
            <SqlExample
              resourceId={resourceId}
              label={t('dataApiSqlAggregate')}
              initialSql={aggregateSql}
            />
          </section>

          <section className="flex flex-col gap-1">
            <h4 className="font-medium">{t('dataApiNotes')}</h4>
            <ul className="list-disc pl-5 text-xs text-muted-foreground [&>li]:mt-1">
              <li>{t('dataApiNoteSelectOnly')}</li>
              <li>{t('dataApiNoteLimits')}</li>
              <li>{t('dataApiNoteAuth')}</li>
              <li>{t('dataApiNoteMcp', { url: `${origin}/api/mcp` })}</li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
