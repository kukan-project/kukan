'use client'

import { Fragment, useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Badge,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  cn,
} from '@kukan/ui'
import { Upload, X, Plus, GripVertical } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { detectFormat, MAX_UPLOAD_SIZE } from '@kukan/shared'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { clientFetch, problemDetail } from '@/lib/client-api'
import { rowActivateProps } from '@/lib/row-activate'
import { takePendingDropFiles } from '@/lib/pending-drop-files'
import { updateResource } from '@/lib/update-resource'
import { useFileDrop } from '@/hooks/use-file-drop'
import { FormatBadge } from '@/components/format-badge'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { ViewPublicLink } from '@/components/dashboard/view-public-link'
import { PipelineStatusBadge } from './pipeline-status-badge'
import { DropFilesZone, dropZoneClass } from './drop-files-zone'
import { FileUploadZone } from './file-upload-zone'
import { ResourceFormFields } from './resource-form-fields'
import { ResourceVersionHistory } from './resource-version-history'
import type { PipelineStatus } from '@/hooks/use-pipeline-status'

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  format?: string | null
  description?: string | null
  pipelineStatus?: PipelineStatus | null
  latestVersion?: number | null
}

interface FormState {
  name: string
  url: string
  urlType: string | null
  format: string
  description: string
}

const emptyForm: FormState = { name: '', url: '', urlType: null, format: '', description: '' }

/** A file dropped on the list, being turned into a resource + upload */
interface DropUpload {
  key: string
  file: File
  resourceId: string | null
  error: string | null
  /** Upload finished — kept until the refetch lands (see completeDropUpload) */
  done?: boolean
}

interface ResourceListProps {
  packageId: string
  /** Dataset name for the public resource links; omitted when there is no
   *  public page to open (a draft is unpublished and has a placeholder name) */
  packageName?: string
  resources: Resource[]
  /** Refetch the parent's package; return false when the refresh could not
   *  be applied — the list then keeps its busy gate up and retries */
  onUpdated: () => void | boolean | Promise<void | boolean>
  /** Reports whether any file upload is still in flight (ADR-040) */
  onUploadingChange?: (uploading: boolean) => void
}

function SortableResourceRow({
  resource: r,
  packageName,
  isDragDisabled,
  isActionsDisabled,
  isActive,
  onEdit,
  onClose,
  onPipelineSettled,
}: {
  resource: Resource
  packageName?: string
  isDragDisabled: boolean
  isActionsDisabled: boolean
  /** True when this row's inline editor is open — a row click then closes it. */
  isActive: boolean
  onEdit: (r: Resource) => void
  onClose: () => void
  onPipelineSettled?: () => void
}) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: r.id,
    disabled: isDragDisabled,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // Row click toggles the inline editor: open it, or close it if already open.
  const toggleEdit = () => {
    if (isActive) onClose()
    else onEdit(r)
  }

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      {...rowActivateProps(toggleEdit, { role: 'button', disabled: isActionsDisabled })}
    >
      <TableCell className="w-8 p-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-30"
          disabled={isDragDisabled}
          aria-label={tc('reorder')}
        >
          <GripVertical className="size-4" />
        </button>
      </TableCell>
      <TableCell>{r.name || '-'}</TableCell>
      <TableCell>{r.format ? <FormatBadge format={r.format} /> : '-'}</TableCell>
      <TableCell className="whitespace-nowrap">
        {r.latestVersion != null ? (
          <Badge variant="secondary">v{r.latestVersion}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {r.urlType === 'upload' ? (
          <Badge variant="outline">{t('sourceUpload')}</Badge>
        ) : r.url ? (
          <Badge variant="outline">{t('sourceUrl')}</Badge>
        ) : (
          '-'
        )}
      </TableCell>
      <TableCell>
        {r.pipelineStatus && (
          <PipelineStatusBadge
            resourceId={r.id}
            initialStatus={r.pipelineStatus}
            onSettled={onPipelineSettled}
          />
        )}
      </TableCell>
      <TableCell>
        {packageName && <ViewPublicLink href={`/dataset/${packageName}/resource/${r.id}`} />}
      </TableCell>
    </TableRow>
  )
}

export function ResourceList({
  packageId,
  packageName,
  resources,
  onUpdated,
  onUploadingChange,
}: ResourceListProps) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')

  // Delete
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Edit / Create shared state
  const [editId, setEditId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [formState, setFormState] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [uploadingResourceId, setUploadingResourceId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Drop-to-create: files dropped anywhere on the list become resources
  const [dropUploads, setDropUploads] = useState<DropUpload[]>([])
  // Serializes resource-creation POSTs (see startDropUpload)
  const createChain = useRef<Promise<unknown>>(Promise.resolve())
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
    }
  }, [])

  // Files dropped on the new-dataset page ride along to this draft's edit
  // page — consume the stash once on mount (see lib/pending-drop-files.ts)
  useEffect(() => {
    for (const file of takePendingDropFiles(packageId)) startDropUpload(file)
  }, [packageId])

  // Report in-flight uploads for the page-level AI-suggest gating (ADR-040);
  // pipeline-starting mutations and the pending post-upload refetch count
  // too (no gap from request to fresh statuses)
  const [refetching, setRefetching] = useState(false)
  const [pipelineOps, setPipelineOps] = useState(0)
  const uploading =
    uploadingResourceId !== null ||
    dropUploads.some((u) => !u.error) ||
    refetching ||
    pipelineOps > 0
  useEffect(() => {
    onUploadingChange?.(uploading)
  }, [uploading, onUploadingChange])

  // Staged order — committed via Save button
  const [items, setItems] = useState<Resource[]>(resources)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)

  useEffect(() => {
    setItems(resources)
  }, [resources])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const isDirty = useMemo(
    () => items.length === resources.length && items.some((r, i) => r.id !== resources[i]?.id),
    [items, resources]
  )

  // Resources still uploading are shown as cards below the table — hide their
  // freshly-created rows so a mid-upload refetch doesn't show them twice
  const visibleItems = useMemo(
    () => items.filter((r) => !dropUploads.some((u) => u.resourceId === r.id)),
    [items, dropUploads]
  )

  const itemIds = useMemo(() => visibleItems.map((r) => r.id), [visibleItems])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = items.findIndex((r) => r.id === active.id)
    const newIndex = items.findIndex((r) => r.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    setItems(arrayMove(items, oldIndex, newIndex))
    setReorderError(null)
  }

  async function saveOrder() {
    setSavingOrder(true)
    setReorderError(null)
    try {
      const res = await clientFetch(`/api/v1/packages/${packageId}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: items.map((r) => r.id) }),
      })
      if (!res.ok) {
        setReorderError(t('reorderFailed'))
        return
      }
      onUpdated()
    } catch {
      setReorderError(t('reorderFailed'))
    } finally {
      setSavingOrder(false)
    }
  }

  function cancelOrder() {
    setItems(resources)
    setReorderError(null)
  }

  const isFormOpen = editId !== null || creating

  // --- Helpers ---

  /** Everything the file half of the form carries, cleared in one place so a
   *  form opening or finishing never leaves part of it behind. */
  function clearUploadState() {
    setFormError(null)
    setReplacing(false)
    setPendingFile(null)
    setUploadingResourceId(null)
    setDragOver(false)
  }

  function resetForm() {
    setEditId(null)
    setCreating(false)
    setFormState(emptyForm)
    clearUploadState()
  }

  function startEdit(r: Resource) {
    setCreating(false)
    setEditId(r.id)
    setFormState({
      name: r.name ?? '',
      url: r.url ?? '',
      urlType: r.urlType ?? null,
      format: r.format ?? '',
      description: r.description ?? '',
    })
    clearUploadState()
  }

  function startCreate() {
    setEditId(null)
    setCreating(true)
    setFormState(emptyForm)
    clearUploadState()
  }

  function handleTabChange(tab: string) {
    setFormState((s) => ({ ...s, urlType: tab === 'upload' ? 'upload' : null }))
    setReplacing(false)
    setPendingFile(null)
  }

  function handleUrlChange(value: string) {
    const detected = detectFormat(value)
    setFormState((s) => ({ ...s, url: value, ...(detected && { format: detected }) }))
  }

  function selectFile(file: File) {
    setPendingFile(file)
    const detected = detectFormat(file.name)
    if (detected) setFormState((s) => ({ ...s, format: detected }))
  }

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) selectFile(file)
  }, [])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) selectFile(file)
  }, [])

  // --- Drop-to-create ---

  // Dropping while a form is open or a reorder is pending would be ambiguous
  const dropEnabled = !isFormOpen && !isDirty && !savingOrder

  const { active: dropActive, handlers: dropHandlers } = useFileDrop({
    disabled: !dropEnabled,
    onFiles: (files) => {
      for (const file of files) startDropUpload(file)
    },
  })

  async function startDropUpload(file: File) {
    const key = crypto.randomUUID()
    const error =
      file.size > MAX_UPLOAD_SIZE
        ? t('fileTooLarge', { size: MAX_UPLOAD_SIZE / 1024 / 1024 })
        : null
    setDropUploads((list) => [...list, { key, file, resourceId: null, error }])
    if (error) return

    const body: Record<string, string> = { name: file.name, urlType: 'upload' }
    const format = detectFormat(file.name)
    if (format) body.format = format
    try {
      const resource = await enqueueCreate(body)
      setDropUploads((list) =>
        list.map((u) => (u.key === key ? { ...u, resourceId: resource.id } : u))
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : t('failedToAdd')
      setDropUploads((list) => list.map((u) => (u.key === key ? { ...u, error: message } : u)))
    }
  }

  // Refetch so finished uploads' rows and settled statuses appear, then drop
  // the done cards. Coalesced — uploads and settles can arrive near-
  // simultaneously; only the last of overlapping refetches may clear the
  // flag and the cards, and a failed refresh keeps the gate up and retries.
  const refetchesInFlight = useRef(0)
  const refetchGen = useRef(0)
  const newestRefetchOk = useRef(true)
  function scheduleRefetch(delay = 200) {
    setRefetching(true)
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null
      const gen = ++refetchGen.current
      refetchesInFlight.current++
      let ok = false
      try {
        ok = (await onUpdated()) !== false
      } catch {
        ok = false
      } finally {
        refetchesInFlight.current--
        // Only the newest run's outcome decides — an older run finishing
        // last with a success must not mask a failed newer fetch
        if (gen === refetchGen.current) newestRefetchOk.current = ok
        if (
          mountedRef.current &&
          refetchesInFlight.current === 0 &&
          refetchTimer.current === null
        ) {
          if (newestRefetchOk.current) {
            setDropUploads((list) => list.filter((x) => !x.done))
            setRefetching(false)
          } else {
            scheduleRefetch(2000)
          }
        }
      }
    }, delay)
  }

  // User dismissed a card — remove it right away; when its resource was
  // already created, refetch so the row appears
  function dismissDropUpload(u: DropUpload) {
    if (!mountedRef.current) return
    setDropUploads((list) => list.filter((x) => x.key !== u.key))
    if (u.resourceId) scheduleRefetch()
  }

  // Upload finished — keep the card (marked done) until the refetch lands so
  // the uploading flag doesn't drop before the queued status becomes visible
  function completeDropUpload(u: DropUpload) {
    // A late completion can arrive after the whole list unmounted (the hook
    // still notifies for in-flight completions) — don't re-register the
    // refetch timer past cleanup
    if (!mountedRef.current) return
    setDropUploads((list) => list.map((x) => (x.key === u.key ? { ...x, done: true } : x)))
    scheduleRefetch()
  }

  // --- Save (edit) ---

  async function handleSave() {
    if (!editId) return
    setSaving(true)
    setFormError(null)
    // Saving a url resource re-enqueues its pipeline server-side, and a
    // pending replacement file leads to an upload — close the gate before
    // the request goes out; on success scheduleRefetch / uploadingResourceId
    // takes over in the same tick, so the gate never gaps
    const startsPipeline = formState.urlType !== 'upload' || !!pendingFile
    if (startsPipeline) setPipelineOps((n) => n + 1)
    try {
      // Overwrite with form state (urlType reflects the user's tab choice); on
      // the upload tab the existing url is kept by omitting it from the patch
      const patch: Record<string, unknown> = {
        name: formState.name || undefined,
        urlType: formState.urlType ?? undefined,
        format: formState.format || undefined,
        description: formState.description || undefined,
      }
      if (formState.urlType !== 'upload') patch.url = formState.url || undefined
      const updated = await updateResource(editId, patch)
      if (!updated.ok) {
        // The server's reason when it gave one — the create path has always
        // shown it, and an edit failing for the same cause used to say only
        // that it failed (kukan#296).
        setFormError(updated.detail ?? t('failedToUpdate'))
        return
      }
      if (pendingFile) {
        setUploadingResourceId(editId)
        return
      }
      resetForm()
      if (startsPipeline) scheduleRefetch()
      else onUpdated()
    } catch {
      setFormError(t('failedToUpdate'))
    } finally {
      if (startsPipeline) setPipelineOps((n) => n - 1)
      setSaving(false)
    }
  }

  // --- Create ---

  /** POST a new resource; throws with the server's problem detail on failure */
  async function createResource(body: Record<string, string>): Promise<Resource> {
    let res: Response
    try {
      res = await clientFetch(`/api/v1/packages/${packageId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error(t('failedToAdd'))
    }
    if (!res.ok) throw new Error((await problemDetail(res)) ?? t('failedToAdd'))
    return res.json()
  }

  // All creations (drop and form) go through one queue so this tab's creates
  // don't interleave and dropped files keep their drop order as positions.
  // Cross-client position races are handled server-side (advisory lock in
  // ResourceService.create()). Uploads themselves stay parallel.
  function enqueueCreate(body: Record<string, string>): Promise<Resource> {
    const run = createChain.current.then(() => createResource(body))
    createChain.current = run.catch(() => undefined)
    return run
  }

  async function handleCreate() {
    setSaving(true)
    setFormError(null)
    // Creating a resource with a url enqueues its pipeline server-side, and
    // creating with a file leads to an upload — close the gate before the
    // request goes out (see handleSave)
    const startsPipeline = formState.urlType === 'upload' ? !!pendingFile : !!formState.url
    if (startsPipeline) setPipelineOps((n) => n + 1)
    try {
      const body: Record<string, string> = {}
      if (formState.name) body.name = formState.name
      if (formState.description) body.description = formState.description

      if (formState.urlType === 'upload') {
        if (!pendingFile) return
        body.urlType = 'upload'
        body.format = formState.format || detectFormat(pendingFile.name) || ''
      } else {
        if (formState.url) body.url = formState.url
        body.format = formState.format || detectFormat(formState.url) || ''
      }
      if (!body.format) delete body.format

      const resource = await enqueueCreate(body)
      if (formState.urlType === 'upload') {
        setUploadingResourceId(resource.id)
      } else {
        resetForm()
        if (resource.url) scheduleRefetch()
        else onUpdated()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failedToAdd'))
    } finally {
      if (startsPipeline) setPipelineOps((n) => n - 1)
      setSaving(false)
    }
  }

  // scheduleRefetch raises the busy gate before resetForm drops the form's
  // uploading state, so consumers never see an idle gap
  function handleUploadComplete() {
    scheduleRefetch()
    // Replacing an existing resource's file keeps its editor open — closing it
    // leaves nothing saying which row was just updated. url/format are set to
    // what the promoted upload wrote server-side (`prepareForUpload` derives
    // them from the same file), so the form names the new file right away.
    if (editId && pendingFile) {
      const detected = detectFormat(pendingFile.name)
      setFormState((s) => ({ ...s, url: pendingFile.name, format: detected || s.format }))
      clearUploadState()
      return
    }
    resetForm()
  }

  // --- Delete ---

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await clientFetch(`/api/v1/resources/${deleteId}`, { method: 'DELETE' })
      if (res.ok) {
        setDeleteId(null)
        // Delete runs from the open editor — close it, its resource is gone
        resetForm()
        onUpdated()
      }
    } finally {
      setDeleting(false)
    }
  }

  // --- Inline form (shared between edit and create) ---

  const isEditing = editId !== null
  const activeFormId = editId ?? (creating ? '__create__' : null)

  function renderInlineForm() {
    if (uploadingResourceId) {
      return (
        <FileUploadZone
          resourceId={uploadingResourceId}
          initialFile={pendingFile ?? undefined}
          onComplete={handleUploadComplete}
        />
      )
    }

    const isUploadTab = formState.urlType === 'upload'
    // The form is open on a resource that already exists, not on a new one
    const isExistingResource = isEditing && !creating

    return (
      <>
        {formError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-4">
          <ResourceFormFields
            idPrefix={isEditing ? 'edit' : 'create'}
            name={formState.name}
            onNameChange={(v) => setFormState((s) => ({ ...s, name: v }))}
            format={formState.format}
            onFormatChange={(v) => setFormState((s) => ({ ...s, format: v }))}
            description={formState.description}
            onDescriptionChange={(v) => setFormState((s) => ({ ...s, description: v }))}
          >
            <Tabs value={isUploadTab ? 'upload' : 'url'} onValueChange={handleTabChange}>
              <TabsList variant="line">
                <TabsTrigger value="url">{t('sourceUrl')}</TabsTrigger>
                <TabsTrigger value="upload">{t('sourceUpload')}</TabsTrigger>
              </TabsList>
              <TabsContent value="url">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${isEditing ? 'edit' : 'create'}-url`}>URL</Label>
                  <Input
                    id={`${isEditing ? 'edit' : 'create'}-url`}
                    value={formState.url}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    placeholder="https://example.com/data.csv"
                  />
                </div>
              </TabsContent>
              <TabsContent value="upload">
                {isExistingResource && !replacing && !pendingFile ? (
                  <div className="flex items-center gap-2 py-2">
                    <Upload className="size-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      {formState.url || t('sourceUpload')}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReplacing(true)}
                    >
                      {t('replaceFile')}
                    </Button>
                  </div>
                ) : (
                  <div
                    className={cn(dropZoneClass(dragOver || !!pendingFile), 'gap-3 p-6')}
                    onDrop={handleFileDrop}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOver(true)
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="size-6 text-muted-foreground" />
                    {pendingFile ? (
                      <span className="flex items-center gap-1 text-sm text-muted-foreground">
                        {pendingFile.name}
                        <button
                          type="button"
                          className="rounded p-0.5 hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPendingFile(null)
                            setReplacing(false)
                          }}
                        >
                          <X className="size-3.5" />
                        </button>
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t('dropFileHere')}</span>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleFileInputChange}
                    />
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </ResourceFormFields>
          <div className="flex gap-2">
            {isEditing ? (
              <Button onClick={handleSave} disabled={saving} variant="outline">
                {saving ? tc('updating') : tc('save')}
              </Button>
            ) : (
              <Button
                onClick={handleCreate}
                disabled={saving || (formState.urlType === 'upload' && !pendingFile)}
                variant="outline"
              >
                {saving ? t('addingResource') : t('addResource')}
              </Button>
            )}
            <Button variant="ghost" onClick={resetForm} disabled={saving}>
              {tc('cancel')}
            </Button>
            {/* Pushed to the far edge, away from Save/Cancel, to keep a
                destructive action out of misclick range of the routine ones */}
            {isExistingResource && (
              <Button
                variant="destructive"
                className="ml-auto"
                onClick={() => setDeleteId(editId)}
                disabled={saving}
              >
                {t('deleteThisResource')}
              </Button>
            )}
          </div>
          {isEditing && !creating && editId && (
            <div className="mt-2 border-t pt-4">
              {/* Moves exactly when a run stored a version, so the open history
                  reloads then and not on every refresh of the package. */}
              <ResourceVersionHistory
                resourceId={editId}
                reloadKey={resources.find((r) => r.id === editId)?.latestVersion ?? 0}
              />
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4" {...dropHandlers}>
      {reorderError && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription>{reorderError}</AlertDescription>
        </Alert>
      )}
      {isDirty && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <span className="text-muted-foreground">{t('reorderPending')}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={cancelOrder} disabled={savingOrder}>
              {tc('cancel')}
            </Button>
            <Button size="sm" onClick={saveOrder} disabled={savingOrder}>
              {savingOrder ? tc('updating') : t('saveOrder')}
            </Button>
          </div>
        </div>
      )}
      {visibleItems.length === 0 && !creating && dropUploads.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('noResources')}</p>
      )}
      {(visibleItems.length > 0 || creating) && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <Table>
            {visibleItems.length > 0 && (
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{tc('name')}</TableHead>
                  <TableHead>{tc('format')}</TableHead>
                  <TableHead>{t('versions.version')}</TableHead>
                  <TableHead>{t('source')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead className="w-[100px]">{tc('actions')}</TableHead>
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                {visibleItems.map((r) => (
                  <Fragment key={r.id}>
                    <SortableResourceRow
                      resource={r}
                      packageName={packageName}
                      isDragDisabled={isFormOpen || savingOrder || dropUploads.length > 0}
                      isActionsDisabled={isDirty || savingOrder}
                      isActive={editId === r.id}
                      onEdit={startEdit}
                      onClose={resetForm}
                      // A settle means the row's status (and maybe others)
                      // changed — refresh through the retrying gate
                      onPipelineSettled={() => scheduleRefetch()}
                    />
                    {activeFormId === r.id && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/30 p-4">
                          {renderInlineForm()}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </SortableContext>
              {creating && (
                <TableRow>
                  <TableCell colSpan={7} className="bg-muted/30 p-4">
                    {renderInlineForm()}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DndContext>
      )}

      {dropUploads.map((u) => (
        <div key={u.key} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className={cn('text-sm', u.error ? 'text-destructive' : 'text-muted-foreground')}>
              {u.file.name}
              {u.error ? `: ${u.error}` : !u.resourceId && ` — ${t('addingResource')}`}
            </span>
            {(u.error || u.resourceId) && !u.done && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => dismissDropUpload(u)}
                aria-label={tc('cancel')}
              >
                <X />
              </Button>
            )}
          </div>
          {!u.error && u.resourceId && (
            <FileUploadZone
              resourceId={u.resourceId}
              initialFile={u.file}
              onComplete={() => completeDropUpload(u)}
            />
          )}
        </div>
      ))}

      {dropEnabled && (
        <DropFilesZone
          hint={t('dropHint')}
          active={dropActive}
          onFiles={(files) => {
            for (const file of files) startDropUpload(file)
          }}
        />
      )}

      {!creating && !editId && (
        <Button variant="outline" size="sm" onClick={startCreate} disabled={isDirty || savingOrder}>
          <Plus className="mr-1 size-4" />
          {t('addResource')}
        </Button>
      )}

      <DeleteConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={t('deleteResource')}
        description={t('deleteResourceConfirm', {
          name: items.find((r) => r.id === deleteId)?.name || t('unnamed'),
        })}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </div>
  )
}
