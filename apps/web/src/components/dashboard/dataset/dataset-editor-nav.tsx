'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { cn } from '@kukan/ui'
import {
  DATASET_LIST,
  datasetEditPath,
  editorStateQuery,
  recallDatasetList,
  resourceEditPath,
} from '@/lib/paths'
import type { EditorPackage } from './dataset-editor-context'
import { ResourceList } from './resource-list'

/**
 * The dataset's contents, in place of the dashboard sidebar while the dataset
 * is open (ADR-072 decision 2): the dataset itself, then its resources — which
 * are arranged here (ADR-050's rules, decision 3) and added from here.
 *
 * On a narrow screen the same list stands above the page instead, folded under
 * a bar naming what is open (decision 8). One list either way: it holds a
 * staged order and uploads in flight, which a second copy would split.
 */
export function DatasetEditorNav({
  pkg,
  readOnly,
  onUpdated,
  onUploadingChange,
  onArrangementDirty,
}: {
  pkg: EditorPackage | null
  /** Nothing to write: the list only shows the resources (see the editor context) */
  readOnly: boolean
  /** Read the dataset again; false when that failed */
  onUpdated: () => Promise<boolean>
  onUploadingChange?: (uploading: boolean) => void
  /** Whether the list holds an order or labels not yet saved */
  onArrangementDirty?: (dirty: boolean) => void
}) {
  const t = useTranslations('datasetEditor')
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const state = searchParams.get('state')
  const query = editorStateQuery(state)
  const datasetHref = pkg ? datasetEditPath(pkg.id) : null
  const activeId = pathname.match(/\/resources\/([^/]+)$/)?.[1] ?? null
  const decodedActiveId = activeId ? decodeURIComponent(activeId) : null
  // Folded on a narrow screen; it folds again once a link in it is followed
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(false)
  }, [pathname])
  // Back to the list as it was left — its view, filters and page. Read after
  // mounting: the server has no tab storage, and the first render must match.
  const [listHref, setListHref] = useState(DATASET_LIST)
  useEffect(() => {
    setListHref(recallDatasetList())
  }, [])
  const openName =
    pkg?.resources.find((r) => r.id === decodedActiveId)?.name || (pkg && (pkg.title || pkg.name))

  return (
    <aside className="w-full shrink-0 md:w-72" aria-label={t('contents')}>
      <nav className="flex flex-col gap-1 md:py-4 md:pr-2">
        <Link
          href={listHref}
          className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('allDatasets')}
        </Link>
        {pkg && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="dataset-editor-contents"
            className="mt-1 flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm md:hidden"
          >
            <span className="min-w-0 truncate font-medium">{openName}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {open ? t('hideContents') : t('showContents')}
              <ChevronDown
                aria-hidden
                className={cn('size-4 transition-transform', open && 'rotate-180')}
              />
            </span>
          </button>
        )}
        {pkg && datasetHref && (
          <div id="dataset-editor-contents" className={cn(open ? 'block' : 'hidden', 'md:block')}>
            <Link
              href={`${datasetHref}${query}`}
              aria-current={pathname === datasetHref ? 'page' : undefined}
              className={cn(
                'mt-2 block rounded-md px-2 py-2 hover:bg-accent',
                pathname === datasetHref && 'bg-accent'
              )}
            >
              <span className="block font-[family-name:var(--font-display)] text-sm font-semibold">
                {pkg.title || pkg.name}
              </span>
              <span className="block text-xs text-muted-foreground">{t('datasetDetails')}</span>
            </Link>
            <div className="mt-2">
              <ResourceList
                packageId={pkg.id}
                resources={pkg.resources}
                hrefFor={(id) => `${resourceEditPath(pkg.id, id)}${query}`}
                activeId={decodedActiveId}
                readOnly={readOnly}
                onUpdated={onUpdated}
                onUploadingChange={onUploadingChange}
                onDirtyChange={onArrangementDirty}
              />
            </div>
          </div>
        )}
      </nav>
    </aside>
  )
}
