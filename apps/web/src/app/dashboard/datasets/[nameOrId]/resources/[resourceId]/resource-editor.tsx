'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Tabs, TabsContent, TabsList, TabsTrigger } from '@kukan/ui'
import {
  isRunActive,
  isTableSourceFormat,
  mayHoldTable,
  showsAsTable,
  type OfficePreviewViewer,
  type ResourceSchema,
} from '@kukan/shared'
import {
  datasetEditPath,
  editorStateQuery,
  externalUrl,
  keepsFilesPrivate,
  resourcePath,
} from '@/lib/paths'
import { useFetch } from '@/hooks/use-fetch'
import { PageHeader } from '@/components/dashboard/page-header'
import { ViewPublicLink } from '@/components/dashboard/dataset/view-public-link'
import { TableSettings } from '@/components/dashboard/dataset/table-settings'
import { ResourceVersionHistory } from '@/components/dashboard/dataset/resource-version-history'
import { ReviewDueDot } from '@/components/dashboard/dataset/pipeline-status-badge'
import { useDatasetEditor } from '@/components/dashboard/dataset/dataset-editor-context'
import {
  ResourceEditForm,
  type EditableResource,
} from '@/components/dashboard/dataset/resource-edit-form'
import { ResourceInfo, type ResourceInfoFields } from '@/components/dashboard/dataset/resource-info'
import { ResourceDeleteCard } from '@/components/dashboard/dataset/resource-delete-card'
import { PipelineStatusDetail } from '@/components/resource/pipeline-status-detail'
import { ResourcePipelinePreview } from '@/components/resource/resource-pipeline-preview'

/** What the Basic tab's form and the information under it read */
type ResourceDetail = EditableResource & ResourceInfoFields

/**
 * One resource in the dataset editor, split into tabs (ADR-072 decision 4):
 * its own fields, then the panels that used to be stacked under them in the
 * dataset page's resource table.
 */
export function ResourceEditor({
  officePreviewViewer,
}: {
  /** The site's Office viewer — read from the environment on the server, as the public page does */
  officePreviewViewer: OfficePreviewViewer
}) {
  const params = useParams()
  const resourceId = params.resourceId as string
  const state = useSearchParams().get('state')
  const tr = useTranslations('resource')
  const td = useTranslations('dataset')
  const tc = useTranslations('common')
  const editor = useDatasetEditor()
  const pkg = editor?.pkg ?? null
  const listed = pkg?.resources.find((r) => r.id === resourceId)
  // What the resource and its panels reload on: a save, a run the list saw
  // under way and now sees settled, and a version the list did not see coming —
  // a run that finished between two reads of the list is never seen under way.
  // The states in between only move the notes on the Preview tab.
  const [settled, setSettled] = useState(0)
  const runStatus = listed?.pipelineStatus
  const [wasActive, setWasActive] = useState(false)
  useEffect(() => {
    if (isRunActive(runStatus)) setWasActive(true)
    else if (wasActive) {
      setWasActive(false)
      setSettled((n) => n + 1)
    }
  }, [runStatus, wasActive])
  const version = listed ? (listed.latestVersion ?? null) : undefined
  const [seenVersion, setSeenVersion] = useState(version)
  useEffect(() => {
    if (version === undefined || version === seenVersion) return
    // The first the list says is where the page started, not a change
    if (seenVersion !== undefined) setSettled((n) => n + 1)
    setSeenVersion(version)
  }, [version, seenVersion])
  const router = useRouter()
  const t = useTranslations('datasetEditor')
  const ts = useTranslations('resource')
  // Unsaved edits on the Basic tab, or a key picked and not applied: leaving
  // the page asks first
  const [dirty, setDirty] = useState(false)
  const [keyDraft, setKeyDraft] = useState(false)
  const setPageUnsaved = editor?.setPageUnsaved
  useEffect(() => {
    setPageUnsaved?.(dirty || keyDraft)
  }, [setPageUnsaved, dirty, keyDraft])
  useEffect(() => () => setPageUnsaved?.(false), [setPageUnsaved])
  // The Table settings tab, once opened, stays mounted like the Basic tab so a
  // key being picked survives a look at another tab. Not before: its sample
  // reads the preview file, which a page opened for its name has no use for.
  const [columnsOpened, setColumnsOpened] = useState(false)
  // The tab this page shows, settled once it first knows what it offers
  const [pageTab, setPageTab] = useState<string | null>(null)
  // A save or an upload under way: deleting meanwhile would race it
  const [busy, setBusy] = useState(false)

  // Read again when a run settles: it may have renamed the format it detected
  const { data: resource, error } = useFetch<ResourceDetail>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}`,
    settled
  )
  // Read once for the tabs and the information under the form. The format is
  // taken from the list where it has loaded, so this goes out beside the read
  // of the resource rather than after it.
  // A workbook is a table only when its reading found columns (ADR-057
  // decision 9). For now its Table settings tab follows that; Step 2 offers
  // the tab on every workbook, as where its reading is settled.
  const schemaPath = mayHoldTable(listed?.format ?? resource?.format)
    ? `/api/v1/resources/${encodeURIComponent(resourceId)}/schema`
    : null
  const { data: schemaData, error: schemaError } = useFetch<{
    schema: ResourceSchema | null
  }>(schemaPath, settled)

  // Not found: never read at all — a refetch that fails keeps what is shown —
  // not one of this dataset's resources (a stale or hand-made address), or
  // under a dataset that could not be read
  const elsewhere = !!pkg && !!resource && !listed
  if ((error && !resource) || elsewhere || editor?.missing) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('resource')} />
        <p className="py-12 text-center text-muted-foreground">{t('resourceNotFound')}</p>
      </div>
    )
  }
  // Who may not write the dataset is turned away, as on the dataset page: the
  // editor is for writers (`canEditPackage`, ADR-072 decision 7). A deleted dataset is the
  // exception, shown read-only to whoever may restore or purge it.
  const deleted = pkg?.state === 'deleted' || state === 'deleted'
  if (pkg && editor?.organizations && !editor.canEdit && !deleted) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('resource')} />
        <p className="py-12 text-center text-muted-foreground">{td('noEditPermission')}</p>
      </div>
    )
  }
  // Inside the editor, nothing is shown until the dataset it belongs to is
  // known: whether it is this dataset's, and who may write it, both hang on it.
  // The first time, a workbook's tabs also wait for its schema, so the page
  // does not open on one tab only to move to the other; a read again keeps the
  // page. A table source is a table whatever its schema says.
  if (
    !resource ||
    (editor && !pkg) ||
    (pageTab === null &&
      schemaPath &&
      !isTableSourceFormat(resource.format) &&
      !schemaData &&
      !schemaError)
  ) {
    return <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
  }

  const reloadKey = settled
  const stateQuery = editorStateQuery(state)
  const readOnly = editor?.readOnly ?? true
  const table = showsAsTable(resource.format, null, schemaData?.schema)
  // A draft and a deleted dataset have no public page to link to
  const publicHref =
    pkg && pkg.state !== 'draft' && pkg.state !== 'deleted'
      ? resourcePath(pkg.name, resource.id)
      : null

  // Opened on the tab the last resource was left on, where this one has it
  // too: a Table settings tab is only for a table, a Processing tab only for a
  // writer. Settled then and kept: a save that turns this resource into a
  // table must not move the page off the form being used.
  // A writer's table has its preview on the Table settings tab, beside the
  // columns it is for; a reader of a table, and every other format, keep the
  // Preview tab
  const settingsTab = table && !readOnly
  const offered = new Set(['basic', 'versions', settingsTab ? 'columns' : 'preview'])
  if (!readOnly) offered.add('processing')
  // The two tabs stand for each other across resources: a preview left open
  // is the Table settings on a table, and the other way round
  const asked = pageTab ?? editor?.resourceTab ?? 'basic'
  const wanted =
    settingsTab && asked === 'preview'
      ? 'columns'
      : !settingsTab && asked === 'columns'
        ? 'preview'
        : asked
  const tab = offered.has(wanted) ? wanted : 'basic'
  if (pageTab !== tab) setPageTab(tab)
  if (tab === 'columns' && !columnsOpened) setColumnsOpened(true)

  /**
   * The public page's own preview, so what is checked here is what readers
   * see — for a draft or a private dataset too, which has no public page yet.
   * On the Preview tab, or on the Table settings tab of a writer's table,
   * opening on the table, marking the key being picked and putting that tab's
   * settings where the fields would be.
   * Mounted only while its tab is open: the table and Office viewers are
   * heavy, and it remounts when a run settles.
   */
  const preview = (primaryKey?: string[] | null, settings?: ReactNode) => (
    <>
      {/* Right after a save or a reprocess the preview is the previous
          version's, or none; say which, rather than leave "no preview" to
          read as final */}
      {isRunActive(listed?.pipelineStatus) && (
        <Alert role="status">
          <AlertDescription>{t('previewWaitingForRun')}</AlertDescription>
        </Alert>
      )}
      {(listed?.pipelineStatus === 'error' || listed?.pipelineStatus === 'cancelled') && (
        <Alert role="status">
          <AlertDescription>
            {/* A reader has no Processing tab to be sent to */}
            {t(readOnly ? 'previewAfterUnfinishedRunReader' : 'previewAfterUnfinishedRun')}
          </AlertDescription>
        </Alert>
      )}
      <ResourcePipelinePreview
        key={reloadKey}
        primaryKey={primaryKey}
        {...(settings !== undefined && { belowTable: settings })}
        resourceId={resource.id}
        format={resource.format}
        url={externalUrl(resource)}
        size={resource.size}
        // Kept away from third-party viewers, as on the public page
        notPublic={!pkg || keepsFilesPrivate(pkg)}
        officePreviewViewer={officePreviewViewer}
        latestVersion={listed?.latestVersion}
        hasTable={table}
      />
    </>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={resource.name || resource.id}>
        {publicHref && <ViewPublicLink href={publicHref} variant="outline" size="default" />}
      </PageHeader>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setPageTab(value)
          editor?.setResourceTab?.(value)
        }}
      >
        {/* The default, filled tabs: the Basic tab holds line tabs of its own
            (link or upload), and the page's sections must not read as those */}
        <TabsList>
          <TabsTrigger value="basic">{t('tabBasic')}</TabsTrigger>
          {/* The table settings under the preview, but where nothing may be
              written: a deleted dataset's column settings and roles are not
              read at all (ADR-072 decision 4) */}
          <TabsTrigger value={settingsTab ? 'columns' : 'preview'}>{t('tabPreview')}</TabsTrigger>
          <TabsTrigger value="versions">
            {t('tabVersions')}
            {/* The list's dot, so the two read as one mark */}
            {listed?.typeReviewDue && !readOnly && <ReviewDueDot label={ts('pipelineReviewDue')} />}
          </TabsTrigger>
          {/* Reprocess, cancel and revert: nothing a reader may do */}
          {!readOnly && <TabsTrigger value="processing">{t('tabProcessing')}</TabsTrigger>}
        </TabsList>

        {/* Kept mounted while another tab is open: unmounted, the form would
            lose what is being typed and an upload under way */}
        <TabsContent
          value="basic"
          forceMount
          className="flex flex-col gap-6 pt-4 data-[state=inactive]:hidden"
        >
          {readOnly ? (
            <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{tc('format')}</dt>
              <dd>{resource.format || '—'}</dd>
              <dt className="text-muted-foreground">{tr('source')}</dt>
              <dd className="break-all">
                {resource.urlType === 'upload' ? tr('sourceUpload') : tr('sourceUrl')}
                {resource.url ? ` — ${resource.url}` : ''}
              </dd>
              <dt className="text-muted-foreground">{tc('description')}</dt>
              <dd className="whitespace-pre-wrap">{resource.description || '—'}</dd>
            </dl>
          ) : (
            <ResourceEditForm
              resource={resource}
              onSaved={() => {
                setSettled((n) => n + 1)
                editor?.reload()
              }}
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
            />
          )}
          <ResourceInfo
            resource={resource}
            latestVersion={listed?.latestVersion}
            schema={schemaData?.schema}
          />
          {!readOnly && (
            <ResourceDeleteCard
              resource={resource}
              disabled={busy}
              onDeleted={() => {
                editor?.reload()
                if (pkg) router.push(`${datasetEditPath(pkg.id)}${stateQuery}`)
              }}
            />
          )}
        </TabsContent>

        {!settingsTab && (
          <TabsContent value="preview" className="flex flex-col gap-4 pt-4">
            {preview(undefined)}
          </TabsContent>
        )}

        {table && !readOnly && (
          <TabsContent
            value="columns"
            forceMount={columnsOpened || undefined}
            className="flex flex-col gap-6 pt-4 data-[state=inactive]:hidden"
          >
            <TableSettings
              resourceId={resource.id}
              reloadKey={reloadKey}
              // Half the public page's height, table or text: the columns below are what the tab is for
              // Only while the tab shows: the tab stays mounted to keep a
              // draft, and the viewers behind a hidden one would go on
              // reading and rebuilding
              preview={
                tab !== 'columns'
                  ? undefined
                  : (key, settings) => (
                      <div className="flex flex-col gap-4 [&_[data-slot=preview-scroll]]:max-h-[300px]">
                        {preview(key, settings)}
                      </div>
                    )
              }
              // The list reads the run back as queued, and its dot follows it
              // until it settles
              onRunQueued={() => editor?.reload()}
              onDraftChange={setKeyDraft}
            />
          </TabsContent>
        )}

        <TabsContent value="versions" className="pt-4">
          <ResourceVersionHistory
            resourceId={resource.id}
            reloadKey={reloadKey}
            // The list reads the review back, and its dot follows
            onReviewed={readOnly ? undefined : () => editor?.reload()}
          />
        </TabsContent>

        {!readOnly && (
          <TabsContent value="processing" className="pt-4">
            {/* The list reads the run back as it starts and as it settles: its
                dot, the preview's notes and the panels here all follow that */}
            <PipelineStatusDetail
              resourceId={resource.id}
              uploaded={!externalUrl(resource)}
              onStarted={() => editor?.reload()}
              onSettled={() => editor?.reload()}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
