'use client'

import { Button } from '@kukan/ui'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

/**
 * The bar under a preview table: what it holds on the left, how to page it on
 * the right.
 *
 * Rendered **inside** the table's border, because the count describes the table
 * rather than the page it is on — which is the one claim here that constrains
 * where a caller may put it.
 *
 * Not `TableFooter`: `@kukan/ui` exports one, and it is a `<tfoot>`.
 */
export function PreviewFooter({
  summary,
  page,
  totalPages,
  busy,
  onPageChange,
}: {
  /** The left-hand text, from the caller: one counts rows and the other counts
   *  the rows a filter left, and only it knows which. */
  summary: string
  /** Zero-based, as both callers hold it. */
  page: number
  totalPages: number
  busy?: boolean
  onPageChange: (page: number) => void
}) {
  const t = useTranslations('resource')
  // The same words the dashboard's pager uses, since these are the same two
  // controls with the label taken off.
  const tc = useTranslations('common')

  return (
    <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
      <span>{summary}</span>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          {/* Named, because the icon is all there is: Lucide marks its SVG
              `aria-hidden`, so without this a screen reader reads both of these
              as "button" and neither says which way it goes. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            aria-label={tc('previous')}
            disabled={page === 0 || busy}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span>{t('previewPage', { current: page + 1, total: totalPages })}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            aria-label={tc('next')}
            disabled={page >= totalPages - 1 || busy}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
