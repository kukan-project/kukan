'use client'

import { useId } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { KeyRound, Table2 } from 'lucide-react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@kukan/ui'
import { odataFeedPath, ODATA_ENTITY_SET } from '@kukan/shared'
import type { OdataKey, OdataRefusal, OdataRefusalReason } from '@kukan/shared'
import { CodeBlock } from './code-block'

/**
 * The refusals this page shows: every one the API names but `not-queryable`,
 * which means there is no table to say anything about.
 *
 * A page too wide to read is not a refusal the API decides — only the read can
 * answer that (ADR-055 §6) — and what this page carries for it is the caution
 * below.
 */
export type ReportedRefusal = OdataRefusal<Exclude<OdataRefusalReason, 'not-queryable'>>

/** How many offending headings the dialog names before it counts the rest. */
const NAMED_COLUMNS = 5

const REFUSAL_MESSAGE = {
  'not-public': 'odataUnavailablePrivate',
  'duplicate-columns': 'odataUnavailableDuplicate',
  'unsupported-columns': 'odataUnavailableColumns',
} as const

/**
 * What this table's rows are identified by, in one sentence.
 *
 * The reason comes from the API because the conditions are the feed's — a
 * designated key is dropped for its type, for a missing value, for repeating,
 * or for a combination the ingest has not settled yet — and each of those is a
 * different thing for the publisher to do next.
 */
function keyNote(t: ReturnType<typeof useTranslations>, key: OdataKey): string {
  return key.synthetic
    ? t(`odataKeyAdded_${key.fallback}`, { column: key.names[0] })
    : t('odataKeyOwn', { columns: key.names.map((n) => `“${n}”`).join(', ') })
}

interface OdataDialogProps {
  resourceId: string
  odataRefusal: ReportedRefusal | null
  /** What the feed identifies rows by, as the API answered for this table. */
  odataKey: OdataKey | null
  /** Whether a page of this table may be too wide to read (ADR-055 §6). */
  odataWideRows: boolean
}

/**
 * The BI tool's way in, beside the developer's: the URL to paste, or why there
 * is none (ADR-055 §1').
 *
 * **Dimmed rather than disabled** where the feed is not served. A disabled
 * button fires no hover events in most browsers, so the `title` explaining it
 * would not appear, and the keyboard could not reach it at all — while the
 * reason worth giving is a list of headings, which is too long for a hover
 * anyway. So it opens, and says what it would take to serve this table.
 */
export function OdataDialog({
  resourceId,
  odataRefusal,
  odataKey,
  odataWideRows,
}: OdataDialogProps) {
  const t = useTranslations('resource')
  const locale = useLocale()

  // Rendered during SSR too (the trigger button), but the URLs only appear
  // inside the dialog content, which mounts client-side on open.
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const odataUrl = `${origin}${odataFeedPath(resourceId)}`

  const named = odataRefusal?.columns.slice(0, NAMED_COLUMNS) ?? []
  const reason = odataRefusal
    ? t(REFUSAL_MESSAGE[odataRefusal.reason], {
        // Joined the way the reader's language does it, rather than with the
        // Japanese comma an English page was getting
        columns: new Intl.ListFormat(locale).format(named.map((c) => `“${c}”`)),
      })
    : null
  const rest =
    odataRefusal && odataRefusal.columns.length > NAMED_COLUMNS
      ? t('odataUnavailableMore', { count: odataRefusal.columns.length - NAMED_COLUMNS })
      : null
  const hovered = reason && `${reason}${rest ? ` ${rest}` : ''}`
  const reasonId = useId()

  return (
    <Dialog>
      <DialogTrigger asChild>
        {/* Dimmed, but neither disabled nor `aria-disabled`: the button does
            work — it explains why the feed is not served — and marking it
            unavailable would tell a screen reader not to press the one control
            that carries the explanation. The reason reaches the pointer through
            `title` and the accessible tree through `aria-describedby`. */}
        <Button
          variant="outline"
          size="sm"
          title={hovered || undefined}
          aria-describedby={hovered ? reasonId : undefined}
          className={cn(odataRefusal && 'text-muted-foreground opacity-60')}
        >
          <Table2 className="size-4" />
          {t('odataButton')}
        </Button>
      </DialogTrigger>
      {hovered && (
        <span id={reasonId} className="sr-only">
          {hovered}
        </span>
      )}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('odataTitle')}</DialogTitle>
          <DialogDescription>
            {odataRefusal ? t('odataUnavailableSummary') : t('odataDescription')}
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, and without it a long URL widens
            the dialog instead of scrolling inside the pre */}
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          {odataRefusal ? (
            // Named rather than omitted: a heading a publisher can fix is the
            // usual reason a table is not served (ADR-055 Step 1).
            <p className="text-xs text-muted-foreground">
              {reason}
              {rest && ` ${rest}`}
            </p>
          ) : (
            <>
              {/* The feed URL leads, because a resource's service document holds
                  exactly one entity set: from the service URL the tool stops to
                  ask which table, and there is only ever one to pick. Measured
                  against Tableau Desktop and Excel — both take either URL, and
                  both resolved `$metadata` correctly from the slash-less service
                  root, so the relative-resolution worry that first put the feed
                  URL here turns out not to arise. */}
              <p className="text-xs text-muted-foreground">{t('odataFeedUrl')}</p>
              <CodeBlock code={`${odataUrl}/${ODATA_ENTITY_SET}`} />
              <p className="text-xs text-muted-foreground">{t('odataServiceUrl')}</p>
              <CodeBlock code={odataUrl} />
              {/* Out of the list of general notes and into a block of its own:
                  this one is an answer about this table — which column the
                  rows come keyed by, and whether one was added — and it read
                  as advice about OData while it sat among the others.
                  Carried at full contrast, unlike the notes around it, because
                  the answer differs from table to table: the others are the
                  same sentences on every resource page and can recede. */}
              {odataKey && (
                <div className="rounded-md border border-l-4 border-l-primary bg-muted p-3">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    <KeyRound className="size-4 shrink-0" aria-hidden />
                    {t('odataKeyHeading')}
                  </p>
                  <p className="mt-1 text-xs text-foreground">
                    {keyNote(t, odataKey)}
                    {/* Only where one was added: there is nothing to remove
                        when the table's own key is what rows come keyed by. */}
                    {odataKey.synthetic && ` ${t('odataKeyRemovable')}`}
                  </p>
                </div>
              )}
              {/* A caution, not a refusal: whether a page reads is the read's
                  own answer (ADR-055 §6), and this table only sits near the
                  line. Said where the URL is copied, because the person copying
                  it is the one who will meet the failure. `status` rather than
                  `alert`: nothing is wrong yet. */}
              {odataWideRows && (
                <p role="status" className="text-xs text-warning-tint-foreground">
                  {t('odataWideRows')}
                </p>
              )}
              <ul className="list-disc pl-5 text-xs text-muted-foreground [&>li]:mt-1">
                <li>{t('odataNoteAuth')}</li>
                <li>{t('odataNoteUrl')}</li>
                <li>{t('odataNotePaging')}</li>
                <li>{t('odataNoteInterpreted')}</li>
              </ul>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
