'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, Skeleton, Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { CsvDialect, OfficePreviewViewer, ResourceSchema } from '@kukan/shared'
import {
  csvRecordLabels,
  dialectOf,
  isCsvFormat,
  isExcelFormat,
  isTextFormat,
  isJsonFormat,
  isZipFormat,
  isOfficeFormat,
  isDocumentFormat,
  isIchitaroFormat,
  isPdfFormat,
  isGeoJsonFormat,
  isImageFormat,
  isMarkdownFormat,
  OFFICE_PREVIEW_LIMIT,
  OFFICE_PREVIEW_LIMIT_MB,
  TEXT_PREVIEW_LIMIT_MB,
  trimTrailing,
} from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { DataExplorer } from '@/components/data-explorer/data-explorer'
import { GeoJsonPreview } from './geojson-preview'
import { JsonPreview } from './json-preview'
import { ZipPreview } from './zip-preview'
import { ImagePreview } from './image-preview'
import { DocumentTextPreview } from './document-text-preview'
import { IchitaroPreview } from './ichitaro-preview'
import { IbisOfficePreview } from './ibis-office-preview'
import { crashedBefore } from '@/lib/original-draw-marks'
import { OFFICE_ONLINE_VIEWER } from '@/lib/csp'

const MarkdownDocument = dynamic(() => import('./markdown-document'), {
  ssr: false,
  loading: () => <PreviewSkeleton />,
})

interface ResourcePreviewProps {
  resourceId: string
  format?: string | null
  /** Original URL for external URL resources (used by Office Online Viewer) */
  url?: string | null
  /** File size in bytes (checked against OFFICE_PREVIEW_LIMIT) */
  size?: number | null
  /**
   * Whether the dataset is private or a draft. Office Online Viewer is not
   * offered then: it would hand the resource's ID and URL to Microsoft's
   * servers, and on a closed network make the browser try to reach them, all
   * to show nothing (the viewer cannot read a file that is not public).
   */
  notPublic?: boolean
  /** What draws an Office file's original; omitted → ibisOffice (ADR-065) */
  officePreviewViewer?: OfficePreviewViewer
  /** The file's version, to tell it from the one that crashed a tab, if one did */
  version?: number | null
  /** The version's column schema, fetched once by the owner (tabular formats only) */
  schema?: ResourceSchema | null
  /**
   * Whether the live version was read as a table, as the server reported it
   * with the page: a workbook picks table or original from this rather than
   * waiting for `schema`. Absent, a workbook is drawn as its original.
   */
  hasTable?: boolean
  /**
   * Open on the table wherever there is one: where the table is what is being
   * set up (the dashboard's table settings), not what a reader looks at first.
   */
  opensOnTable?: boolean
  /**
   * The view shown, kept by an owner that shows what goes with the table view
   * ({@link usePreviewView}); with no `onViewChange` the preview keeps its own.
   */
  view?: PreviewView
  onViewChange?: (view: PreviewView) => void
  /** The resource's settled primary key, from the same read */
  primaryKey?: string[] | null
}

/** A preview's views, where an owner keeps which one shows. */
export type PreviewView = 'original' | 'table' | 'text' | 'map'

/** What decides the view a preview opens on. */
type PreviewOpening = Pick<
  ResourcePreviewProps,
  | 'resourceId'
  | 'format'
  | 'version'
  | 'schema'
  | 'hasTable'
  | 'opensOnTable'
  | 'notPublic'
  | 'officePreviewViewer'
>

/**
 * The view a resource's preview shows, and the way to change it: kept by
 * whoever also shows what goes with the table view (the field list, the table
 * settings), so that is right from the first frame. A table opens on itself
 * but a GeoJSON's, which opens on its map, and a workbook's, which opens on its
 * original unless that took a tab down last time (or there is none to draw).
 * Undefined while the browser is asked about that.
 */
export function usePreviewView(
  opening: PreviewOpening
): [PreviewView | undefined, (view: PreviewView) => void] {
  const [picked, setPicked] = useState<PreviewView>()
  const f = opening.format ?? null
  const workbook = isExcelFormat(f) && !!opening.hasTable
  const doc = docOf(opening)
  const hasOriginal =
    workbook &&
    officeOriginal({
      ...opening,
      format: f!,
      officePreviewViewer: opening.officePreviewViewer ?? 'ibis-office',
      doc,
    }) !== undefined
  const asksCrash = hasOriginal && !opening.opensOnTable
  const crashed = useCrashedBefore(asksCrash ? doc : null)
  if (picked) return [picked, setPicked]
  const columns = (opening.schema?.columns.length ?? 0) > 0
  const opens: PreviewView | undefined = isCsvFormat(f)
    ? 'table'
    : isGeoJsonFormat(f)
      ? // On the map everywhere, the settings' tab too: the map is what a GeoJSON is looked at as
        'map'
      : isJsonFormat(f)
        ? columns
          ? 'table'
          : 'original'
        : !asksCrash
          ? workbook
            ? 'table'
            : 'original'
          : crashed === undefined
            ? undefined
            : crashed
              ? 'table'
              : 'original'
  return [opens, setPicked]
}

const docOf = ({ resourceId, version }: Pick<PreviewOpening, 'resourceId' | 'version'>) =>
  `${resourceId}:${version ?? 0}`

/**
 * Whether this document's original took a tab down last time, once the
 * browser has said: undefined until then, and for no document.
 */
function useCrashedBefore(doc: string | null): boolean | undefined {
  const [answer, setAnswer] = useState<{ doc: string; crashed: boolean }>()
  useEffect(() => {
    if (doc) setAnswer({ doc, crashed: crashedBefore(doc) })
  }, [doc])
  return doc && answer?.doc === doc ? answer.crashed : undefined
}

/**
 * Checks for Parquet preview (pipeline output) first.
 * PDF is displayed via Storage signed URL (iframe).
 * TXT is displayed as raw text.
 * If no preview data exists in Storage, shows "not available".
 */
export function ResourcePreview(props: ResourcePreviewProps) {
  return props.onViewChange ? <PreviewOf {...props} /> : <OwnViewPreview {...props} />
}

/** A preview with no owner to keep its view: it keeps its own. */
function OwnViewPreview(props: ResourcePreviewProps) {
  const [view, setView] = usePreviewView(props)
  return <PreviewOf {...props} view={view} onViewChange={setView} />
}

function PreviewOf({
  resourceId,
  format,
  url,
  size,
  notPublic,
  officePreviewViewer = 'ibis-office',
  version,
  schema,
  hasTable,
  primaryKey,
  view,
  onViewChange,
}: ResourcePreviewProps) {
  const f = format ?? null
  const doc = docOf({ resourceId, version })
  const table = { resourceId, schema, primaryKey, view, onViewChange }

  if (isImageFormat(f)) return <ImagePreview resourceId={resourceId} />
  if (isPdfFormat(f))
    return (
      <DocumentPreview
        key={resourceId}
        resourceId={resourceId}
        format={f!}
        original={<PdfPreview resourceId={resourceId} />}
      />
    )
  if (isCsvFormat(f))
    return (
      <TablePreview
        key={resourceId}
        {...table}
        format={f!}
        original={<RawTextPreview resourceId={resourceId} dialect={dialectOf(schema)} />}
      />
    )
  if (isGeoJsonFormat(f))
    return (
      <GeoJsonPreview
        resourceId={resourceId}
        schema={schema}
        primaryKey={primaryKey}
        view={view as 'map' | 'table' | 'original' | undefined}
        onViewChange={onViewChange}
      />
    )
  // A JSON whose records the interpretation read as a table (ADR-063
  // extension) is shown as one, the file itself a toggle away; any other JSON
  // is the file
  if (isJsonFormat(f))
    return schema?.columns.length ? (
      <TablePreview
        key={resourceId}
        {...table}
        format="JSON"
        original={<JsonPreview resourceId={resourceId} />}
      />
    ) : (
      <JsonPreview resourceId={resourceId} />
    )
  if (isZipFormat(f)) return <ZipPreview resourceId={resourceId} />
  if (f && isOfficeFormat(f)) {
    const original = officeOriginal({
      resourceId,
      format: f,
      url,
      size,
      notPublic,
      officePreviewViewer,
      doc,
    })
    // A workbook the interpretation read as a table (ADR-057 decision 9): its
    // original, the table and the extracted text side by side
    if (isExcelFormat(f) && hasTable) {
      if (!view) return <PreviewSkeleton />
      return <TablePreview key={resourceId} {...table} format={f} original={original} withText />
    }
    if (!original) return <DocumentTextPreview resourceId={resourceId} />
    return (
      <RememberedOriginal
        key={`${doc}:${f}`}
        resourceId={resourceId}
        format={f}
        doc={doc}
        original={original}
      />
    )
  }
  if (isIchitaroFormat(f))
    return (
      <RememberedOriginal
        key={doc}
        resourceId={resourceId}
        format={f!}
        doc={doc}
        original={
          <IchitaroPreview
            resourceId={resourceId}
            doc={doc}
            size={size}
            fallback={<OriginalNotShown message="previewIchitaroOriginal" />}
          />
        }
      />
    )
  if (isMarkdownFormat(f)) return <MarkdownPreview key={resourceId} resourceId={resourceId} />
  if (isTextFormat(f)) return <TextOnlyPreview resourceId={resourceId} />
  if (isDocumentFormat(f)) return <DocumentTextPreview resourceId={resourceId} />
  return <PreviewNotAvailable />
}

/**
 * What draws an Office file's original, or nothing where none may be drawn (a
 * private file and Microsoft's viewer). ibisOffice draws in the visitor's
 * browser, from the file the visitor may read, so a private dataset's files
 * are drawn too.
 */
function officeOriginal({
  resourceId,
  format,
  url,
  size,
  notPublic,
  officePreviewViewer,
  doc,
}: {
  resourceId: string
  format: string
  url?: string | null
  size?: number | null
  notPublic?: boolean
  officePreviewViewer: OfficePreviewViewer
  doc: string
}): ReactNode | undefined {
  if (officePreviewViewer === 'ibis-office')
    return <IbisOfficePreview resourceId={resourceId} doc={doc} format={format} size={size} />
  if (notPublic) return undefined
  return <OfficeOnlinePreview resourceId={resourceId} url={url} size={size} />
}

/**
 * A document as itself, where the browser can show it, or as the text
 * extracted from it — the second is what search and AI see of the file.
 */
function DocumentPreview({
  resourceId,
  format,
  original,
  initial = 'original',
}: {
  resourceId: string
  /** Named on the original's badge, as every preview names its original */
  format: string
  original: ReactNode
  initial?: 'original' | 'text'
}) {
  const t = useTranslations('resource')
  return (
    <KeptViews
      initial={initial}
      views={[
        {
          key: 'original',
          label: t('previewSourceOriginal', { format: format.toUpperCase() }),
          node: original,
        },
        {
          key: 'text',
          label: t('previewSourceExtractedText'),
          node: <DocumentTextPreview resourceId={resourceId} />,
        },
      ]}
    />
  )
}

/**
 * A document's original, opening on its extracted text if that took a tab down
 * last time, the original a tab away to try again. Known only in the browser, so
 * the choice waits for the first effect.
 */
function RememberedOriginal({
  resourceId,
  format,
  doc,
  original,
}: {
  resourceId: string
  format: string
  doc: string
  original: ReactNode
}) {
  const crashed = useCrashedBefore(doc)
  if (crashed === undefined) return <PreviewSkeleton />
  return (
    <DocumentPreview
      resourceId={resourceId}
      format={format}
      initial={crashed ? 'text' : 'original'}
      original={original}
    />
  )
}

/**
 * Views of one resource behind a row of badges. Each stays mounted once
 * shown, so switching back neither loads nor draws it again, but for an original
 * too heavy to leave running, which closes itself while hidden. The view shown
 * is `value` where an owner keeps it, else this keeps its own from `initial`.
 */
function KeptViews<K extends string>({
  views,
  value,
  initial,
  onChange,
}: {
  views: { key: K; label: string; node: ReactNode }[]
  value?: K
  initial?: K
  onChange?: (key: K) => void
}) {
  const [own, setOwn] = useState<K>(() => value ?? initial ?? views[0]!.key)
  const source = value ?? own
  const [shown, setShown] = useState<Set<K>>(() => new Set([source]))
  // During render: a view an owner switched to is drawn in the same pass
  if (!shown.has(source)) setShown(new Set(shown).add(source))
  const show = (key: K) => {
    setOwn(key)
    onChange?.(key)
  }

  return (
    <div className="flex flex-col gap-2">
      <SourceToggle sources={views} value={source} onChange={show} />
      {views.map(
        (view) =>
          shown.has(view.key) && (
            <div key={view.key} hidden={source !== view.key}>
              {view.node}
            </div>
          )
      )}
    </div>
  )
}

/** The row of badges a preview switches its views with. */
export function SourceToggle<K extends string>({
  sources,
  value,
  onChange,
}: {
  sources: { key: K; label: string }[]
  value: K
  onChange: (key: K) => void
}) {
  return (
    <div className="flex gap-2">
      {sources.map((s) => (
        <Badge
          key={s.key}
          variant={value === s.key ? 'default' : 'outline'}
          className="cursor-pointer"
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </Badge>
      ))}
    </div>
  )
}

function TextOnlyPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Badge variant="default">{t('previewSourceText')}</Badge>
      </div>
      <RawTextPreview resourceId={resourceId} />
    </div>
  )
}

/**
 * A Markdown file as the document it writes, as the text it is, or as the
 * text extracted from it under its headings — what search and AI see of it.
 * One read serves the first two: the file is the same, only the drawing
 * differs; the third is its own artifact, loaded when first shown.
 */
function MarkdownPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const loaded = useResourceText(resourceId)
  const drawn = (draw: (text: string) => ReactNode) => <LoadedText loaded={loaded} draw={draw} />

  return (
    <KeptViews
      initial="formatted"
      views={[
        {
          key: 'formatted',
          label: t('previewSourceFormatted'),
          node: drawn((text) => (
            <TextFrame encoding={loaded.encoding} truncated={loaded.truncated}>
              <div className="max-h-[70vh] overflow-auto px-6 py-6 sm:px-10 sm:py-8">
                <MarkdownDocument text={text} />
              </div>
            </TextFrame>
          )),
        },
        {
          key: 'raw',
          label: t('previewSourceMarkdownSource'),
          node: drawn((text) => (
            <RawTextView text={text} encoding={loaded.encoding} truncated={loaded.truncated} />
          )),
        },
        {
          key: 'extracted',
          label: t('previewSourceExtractedText'),
          node: <DocumentTextPreview resourceId={resourceId} />,
        },
      ]}
    />
  )
}

/** The table read from a resource, with what it does not hold said above it. */
function TableView({
  resourceId,
  schema,
  primaryKey,
}: {
  resourceId: string
  schema?: ResourceSchema | null
  primaryKey?: string[] | null
}) {
  return (
    <>
      <DroppedRowsNote schema={schema} />
      <DataExplorer
        resourceId={resourceId}
        primaryKey={primaryKey}
        schemaColumns={schema?.columns ?? null}
      />
    </>
  )
}

/**
 * The table read from a resource behind a row of badges: its original first,
 * as every preview orders its views, where there is one to draw, and the text
 * extracted from it after, where it is a document (a workbook).
 */
function TablePreview({
  resourceId,
  format,
  schema,
  primaryKey,
  original,
  withText,
  view,
  onViewChange,
}: {
  resourceId: string
  schema?: ResourceSchema | null
  primaryKey?: string[] | null
  /** The file's format, named on its original's badge */
  format: string
  original?: ReactNode
  withText?: boolean
  view?: PreviewView
  onViewChange?: (view: PreviewView) => void
}) {
  const t = useTranslations('resource')
  return (
    <KeptViews<PreviewView>
      value={view}
      initial="table"
      onChange={onViewChange}
      views={[
        ...(original
          ? [
              {
                key: 'original' as const,
                label: t('previewSourceOriginal', { format: format.toUpperCase() }),
                node: original,
              },
            ]
          : []),
        {
          key: 'table',
          label: t('previewSourceTable'),
          node: <TableView resourceId={resourceId} schema={schema} primaryKey={primaryKey} />,
        },
        ...(withText
          ? [
              {
                key: 'text' as const,
                label: t('previewSourceExtractedText'),
                node: <DocumentTextPreview resourceId={resourceId} />,
              },
            ]
          : []),
      ]}
    />
  )
}

/**
 * Lines of the file that are not rows of this table (ADR-046) — one written too
 * short for the reader to seat, or a note padded out to the width and taken from
 * the table itself.
 *
 * Said where the table is, not inside it: a `count(*)` in the explorer returns
 * the short number with nothing to say why. Not shown over the raw text, which
 * is the file and does hold them.
 */
function DroppedRowsNote({ schema }: { schema?: ResourceSchema | null }) {
  const t = useTranslations('resource')
  const count = schema?.droppedRows ?? 0
  const lines = schema?.droppedLines ?? []
  if (count === 0) return null

  // Three whole sentences rather than a count with a list bracketed onto it:
  // the brackets belong to the language, and a schema can carry the count
  // without the lines — the two are separately optional, and one written by a
  // reader that only had the count would otherwise render "(at line  and
  // more)". The list is bounded, so it says "and more" when it is shorter.
  const key =
    lines.length === 0
      ? 'previewDroppedRows'
      : lines.length < count
        ? 'previewDroppedRowsMore'
        : 'previewDroppedRowsAt'

  return (
    <p className="text-xs text-warning-tint-foreground">
      {t(key, { count, lines: lines.join(', ') })}
    </p>
  )
}

// --- Text Preview ---

interface ResourceText {
  text: string | null
  encoding: string
  truncated: boolean
  loading: boolean
  error: boolean
}

/** The first `TEXT_PREVIEW_LIMIT` bytes of the file, decoded as the server detected them. */
function useResourceText(resourceId: string): ResourceText {
  const [text, setText] = useState<string | null>(null)
  const [encoding, setEncoding] = useState<string>('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/text`)
        if (!res.ok) throw new Error()
        if (cancelled) return

        setEncoding(res.headers.get('X-Detected-Encoding') || '')
        setTruncated(res.headers.get('X-Truncated') === 'true')

        const ct = res.headers.get('Content-Type') || ''
        const charsetMatch = ct.match(/charset=([^\s;]+)/)
        const charset = charsetMatch?.[1] || 'utf-8'
        const buf = await res.arrayBuffer()
        const decoded = new TextDecoder(charset).decode(buf)
        // Remove trailing replacement chars from truncated multi-byte sequences
        setText(trimTrailing(decoded, '\uFFFD'))
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  return { text, encoding, truncated, loading, error }
}

function RawTextPreview({
  resourceId,
  dialect,
}: {
  resourceId: string
  dialect?: CsvDialect | null
}) {
  const loaded = useResourceText(resourceId)
  return (
    <LoadedText
      loaded={loaded}
      draw={(text) => (
        <RawTextView
          text={text}
          encoding={loaded.encoding}
          truncated={loaded.truncated}
          dialect={dialect}
        />
      )}
    />
  )
}

/** The file's text drawn by `draw`, once it has loaded with any. */
function LoadedText({ loaded, draw }: { loaded: ResourceText; draw: (text: string) => ReactNode }) {
  if (loaded.loading) return <PreviewSkeleton />
  if (loaded.error) return <PreviewError />
  if (!loaded.text) return <PreviewEmpty />
  return draw(loaded.text)
}

function RawTextView({
  text,
  encoding,
  truncated,
  dialect,
}: {
  text: string
  encoding: string
  truncated: boolean
  dialect?: CsvDialect | null
}) {
  // Memoized because the walk is over up to 1 MB of text, repeated on every
  // parent toggle otherwise.
  const gutter = useMemo(() => {
    const lines = text.split('\n')
    // A trailing newline is the end of the last line, not a line of its own
    if (lines[lines.length - 1] === '') lines.pop()
    return csvRecordLabels(lines, dialect).join('\n')
  }, [text, dialect])

  return (
    <TextFrame encoding={encoding} truncated={truncated}>
      <div data-slot="preview-scroll" className="max-h-[600px] overflow-auto bg-muted/20">
        <div className="flex min-w-max">
          <pre
            aria-hidden="true"
            className="sticky left-0 select-none border-r bg-muted px-3 py-4 text-right text-xs text-muted-foreground"
          >
            {gutter}
          </pre>
          <pre className="whitespace-pre p-4 text-xs">{text}</pre>
        </div>
      </div>
    </TextFrame>
  )
}

/** The bordered box a text view sits in, with the encoding and the cut below it. */
function TextFrame({
  encoding,
  truncated,
  children,
}: {
  encoding: string
  truncated: boolean
  children: ReactNode
}) {
  const t = useTranslations('resource')
  return (
    <div className="overflow-hidden rounded-lg border">
      {children}
      {(encoding || truncated) && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          {encoding && <span>{t('previewEncoding', { encoding })}</span>}
          {truncated && <span>{t('previewTruncated', { mb: TEXT_PREVIEW_LIMIT_MB })}</span>}
        </div>
      )}
    </div>
  )
}

// --- PDF Preview ---

function PdfPreview({ resourceId }: { resourceId: string }) {
  const t = useTranslations('resource')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const previewUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const res = await clientFetch(previewUrl, { method: 'HEAD' })
        if (!cancelled) setState(res.ok ? 'ready' : 'error')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  if (state === 'loading') return <PreviewSkeleton />
  if (state === 'error') return <PreviewError />

  return (
    <div className="overflow-hidden rounded-lg border">
      <iframe
        src={previewUrl}
        title={t('preview')}
        className="block h-[700px] w-full"
        style={{ border: 'none' }}
      />
    </div>
  )
}

// --- Office Online Preview (Excel / Word) ---

const OFFICE_VIEWER_BASE = `${OFFICE_ONLINE_VIEWER}/op/embed.aspx`

function OfficeOnlinePreview({
  resourceId,
  url,
  size,
}: {
  resourceId: string
  url?: string | null
  size?: number | null
}) {
  const t = useTranslations('resource')
  // Phase: 'visible' → 'fading' → 'hidden'
  const [phase, setPhase] = useState<'visible' | 'fading' | 'hidden'>('visible')

  useEffect(() => {
    const fadeTimer = setTimeout(() => setPhase('fading'), 1000)
    return () => clearTimeout(fadeTimer)
  }, [])
  useEffect(() => {
    if (phase !== 'fading') return
    const removeTimer = setTimeout(() => setPhase('hidden'), 1000)
    return () => clearTimeout(removeTimer)
  }, [phase])

  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

  // External URL resources: use original URL directly (works even on localhost)
  // Uploaded resources: use KUKAN API endpoint (requires public deployment)
  let fileUrl: string | null = null
  if (url) {
    fileUrl = url
  } else if (!isLocal && typeof window !== 'undefined') {
    fileUrl = `${window.location.origin}/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
  }

  if (size && size > OFFICE_PREVIEW_LIMIT) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewOfficeTooLarge', { mb: OFFICE_PREVIEW_LIMIT_MB })}
        </CardContent>
      </Card>
    )
  }

  if (!fileUrl) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewOfficeLocalUnavailable')}
        </CardContent>
      </Card>
    )
  }

  const viewerUrl = `${OFFICE_VIEWER_BASE}?src=${encodeURIComponent(fileUrl)}`

  return (
    <div className="flex flex-col gap-1">
      <div className="relative overflow-hidden rounded-lg border">
        {phase !== 'hidden' && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-background transition-opacity duration-[1000ms]"
            style={{ opacity: phase === 'fading' ? 0 : 1 }}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground/20 border-t-primary" />
              <p className="text-sm text-muted-foreground">{t('previewLoading')}</p>
            </div>
          </div>
        )}
        <iframe
          src={viewerUrl}
          title={t('preview')}
          className="block h-[700px] w-full"
          style={{ border: 'none' }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('previewOfficeOnline')}</p>
    </div>
  )
}

// --- Shared UI ---

/** In place of an original no browser can show: what to open it in instead. */
function OriginalNotShown({ message }: { message: 'previewIchitaroOriginal' }) {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t(message)}
      </CardContent>
    </Card>
  )
}

function PreviewNotAvailable() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewNotAvailable')}
      </CardContent>
    </Card>
  )
}

export function PreviewSkeleton() {
  const t = useTranslations('common')
  return (
    <Card role="status">
      <CardContent className="space-y-3 p-4">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </CardContent>
    </Card>
  )
}

export function PreviewError() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewError')}
      </CardContent>
    </Card>
  )
}

function PreviewEmpty() {
  const t = useTranslations('resource')
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {t('previewEmpty')}
      </CardContent>
    </Card>
  )
}
