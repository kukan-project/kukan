'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Separator } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { datasetEditPath, editorStateQuery } from '@/lib/paths'
import { canEditPackage } from '@/lib/roles'
import { useFetch } from '@/hooks/use-fetch'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useTranslations } from 'next-intl'
import { useUser } from '@/components/dashboard/user-provider'
import {
  DatasetEditorProvider,
  type EditorPackage,
} from '@/components/dashboard/dataset/dataset-editor-context'
import { DatasetEditorNav } from '@/components/dashboard/dataset/dataset-editor-nav'

interface Membership {
  id: string
  name: string
  title?: string | null
  role?: string
}

const NO_MEMBERSHIPS: Membership[] = []

/**
 * The dataset editor's frame: the dataset's contents on the left, in place of
 * the dashboard sidebar, and the dataset or the selected resource on the right
 * — the public dataset page's two columns (ADR-072 decision 2).
 */
export default function DatasetEditorLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const nameOrId = params.nameOrId as string
  const searchParams = useSearchParams()
  const state = searchParams.get('state')
  const pathname = usePathname()
  const router = useRouter()
  const user = useUser()
  const [pkg, setPkg] = useState<EditorPackage | null>(null)
  const [uploading, setUploading] = useState(false)
  // Unsaved edits on the open page, and an order or labels staged in the list.
  // The list stays while the editor's own pages change under it, so its
  // staging is asked about only on leaving the editor; the page's on any link.
  const t = useTranslations('datasetEditor')
  const [pageUnsaved, setPageUnsaved] = useState(false)
  const [arrangementUnsaved, setArrangementUnsaved] = useState(false)
  useLeaveGuard(
    pageUnsaved || arrangementUnsaved,
    t('leaveUnsaved'),
    pageUnsaved ? null : `/dashboard/datasets/${pkg?.id ?? nameOrId}`
  )
  const pageReloader = useRef<(() => Promise<boolean>) | null>(null)
  // Out-of-order answers must not roll the list back (see the dataset page)
  const seq = useRef(0)
  const applied = useRef(0)

  const apply = useCallback((next: EditorPackage, at: number) => {
    if (at <= applied.current) return
    applied.current = at
    setPkg({ ...next, resources: next.resources ?? [] })
  }, [])

  // The list's links address the dataset by id. Opened by name, the first of
  // them would change this segment and remount the editor, dropping a staged
  // order and uploads in flight — so move to the id as soon as it is known.
  const loadedId = pkg?.id
  useEffect(() => {
    if (!loadedId || loadedId === nameOrId) return
    const rest = pathname.replace(/^\/dashboard\/datasets\/[^/]+/, '')
    const query = searchParams.toString()
    router.replace(`${datasetEditPath(loadedId)}${rest}${query ? `?${query}` : ''}`)
  }, [loadedId, nameOrId, pathname, searchParams, router])

  // Who may arrange and edit: the API's write rule, as the dataset page asks it
  const { data: orgData, error: orgsFailed } = useFetch<{ items: Membership[] }>(
    '/api/v1/users/me/organizations'
  )
  // Memberships that could not be read count as none, rather than as not yet
  // known: the screens would otherwise wait for them for good. A sysadmin and a
  // draft's creator still write; anyone else is shown the dataset read-only.
  const memberships = orgData?.items ?? (orgsFailed ? NO_MEMBERSHIPS : null)
  const canEdit =
    !!pkg &&
    memberships !== null &&
    canEditPackage(user, pkg, memberships.find((o) => o.id === pkg.ownerOrg)?.role)
  // A deleted dataset cannot be written (ADR-072 decision 4), nor can one the viewer only reads
  const readOnly = pkg?.state === 'deleted' || state === 'deleted' || !canEdit

  /** False when the dataset could not be read — the list keeps its busy gate up and retries */
  const reload = useCallback(async (): Promise<boolean> => {
    const at = ++seq.current
    const target = encodeURIComponent(nameOrId)
    const stateQuery = editorStateQuery(state)
    try {
      let res = await clientFetch(`/api/v1/packages/${target}${stateQuery}`)
      // A draft opened without ?state=draft 404s on the active path, and one
      // published since it was opened 404s on the draft path
      if (!res.ok && state !== 'deleted') {
        res = await clientFetch(`/api/v1/packages/${target}${stateQuery ? '' : '?state=draft'}`)
      }
      if (!res.ok) return false
      apply(await res.json(), at)
      return true
    } catch {
      return false
    }
  }, [nameOrId, state, apply])

  const [missing, setMissing] = useState(false)
  useEffect(() => {
    void reload().then((ok) => setMissing(!ok))
  }, [reload])

  const value = useMemo(
    () => ({
      pkg,
      mark: () => ++seq.current,
      publish: apply,
      reload,
      canEdit,
      readOnly,
      organizations: memberships,
      setPageReloader: (fn: (() => Promise<boolean>) | null) => {
        pageReloader.current = fn
      },
      uploading,
      setPageUnsaved,
      // Only while nothing has been read: a later read, or the dataset page
      // handing its own copy over, answers it
      missing: missing && !pkg,
    }),
    [pkg, apply, reload, uploading, canEdit, readOnly, memberships, missing]
  )

  return (
    <DatasetEditorProvider value={value}>
      {/* One column on a narrow screen, the list above the page (ADR-072 decision 8) */}
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <DatasetEditorNav
          pkg={pkg}
          readOnly={readOnly}
          // The dataset page, when open, reads its full copy and hands it to
          // the list; otherwise the list's own copy is read
          onUpdated={() => (pageReloader.current ?? reload)()}
          onUploadingChange={setUploading}
          onArrangementDirty={setArrangementUnsaved}
        />
        <Separator orientation="vertical" className="hidden md:block" />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </DatasetEditorProvider>
  )
}
