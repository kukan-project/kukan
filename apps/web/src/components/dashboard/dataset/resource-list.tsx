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
  Field,
  FieldControl,
  FieldLabel,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  cn,
} from '@kukan/ui'
import { Upload, X, Plus, GripVertical, Pencil } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  detectFormat,
  isCsvFormat,
  normalizeSection,
  splitSection,
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_MB,
} from '@kukan/shared'
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
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { clientFetch, problemDetail } from '@/lib/client-api'
import { rowActivateProps } from '@/lib/row-activate'
import { takePendingDropFiles } from '@/lib/pending-drop-files'
import { updateResource } from '@/lib/update-resource'
import {
  opensSection,
  sectionRunEnd,
  placeDivider,
  dropRow,
  dividerLanding,
  rowIndexById,
  anchorIndex,
  sectionDragId,
  pendingDragId,
  rowIdOfDragId,
  pendingIdOfDragId,
  isSectionDragId,
  isPendingDragId,
} from '@/lib/resource-sections'
import { useFileDrop } from '@/hooks/use-file-drop'
import { FormatBadge } from '@/components/format-badge'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { ViewPublicLink } from '@/components/dashboard/view-public-link'
import { PipelineStatusBadge } from './pipeline-status-badge'
import { DropFilesZone, dropZoneClass } from './drop-files-zone'
import { FileUploadZone } from './file-upload-zone'
import { ResourceFormFields } from './resource-form-fields'
import { PrimaryKeyPicker } from './primary-key-picker'
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
  section?: string | null
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

/** Columns the table has, so a heading spans the row rather than sitting in one cell. */
const COLUMN_COUNT = 7

/** A heading with nothing under it yet — unsaved, held until a resource joins it (ADR-050). */
interface PendingSection {
  id: string
  name: string
  /** The row it stands above, or null for the end of the list — an anchor, like
   *  a saved heading's, so it follows the list without bookkeeping. Headings
   *  sharing an anchor are drawn in list order. */
  above: string | null
}

/** The heading being typed for a new section; it has no name yet, so it is not a pending. */
const DRAFT_ID = pendingDragId('draft')

/** One section's heading: a divider, not a row (ADR-050). The draft lives here
 *  so typing a name does not re-render the list. */
function SectionHeadingRow({
  sortableId,
  label,
  editing,
  onCommit,
  onCancel,
  onRename,
  onDissolve,
  isTaken,
  disabled,
}: {
  sortableId: string
  label: string
  editing: boolean
  onCommit: (name: string) => void
  onCancel: () => void
  onRename: () => void
  onDissolve: () => void
  /** Whether the name would stand in two places — a section is one run (ADR-050). */
  isTaken: (name: string) => boolean
  disabled: boolean
}) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const [draft, setDraft] = useState(label)
  const name = normalizeSection(draft)
  const taken = editing && name !== null && isTaken(name)
  const canSave = name !== null && !taken
  useEffect(() => {
    if (editing) setDraft(label)
  }, [editing, label])
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled,
  })

  return (
    <TableRow
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      // Tinted with the brand colour rather than the neutral grey a hovered row
      // takes, so a heading and a hovered row cannot be mistaken for each other
      className="bg-primary/10 hover:bg-primary/10"
    >
      <TableCell className="w-8 p-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-30"
          disabled={disabled}
          aria-label={t('reorderSection')}
        >
          <GripVertical className="size-4" />
        </button>
      </TableCell>
      <TableCell colSpan={COLUMN_COUNT - 1} className="py-1.5">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              value={draft}
              aria-label={t('sectionName')}
              placeholder={t('sectionNamePlaceholder')}
              className="h-8 max-w-64"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (canSave) onCommit(draft)
                } else if (e.key === 'Escape') {
                  onCancel()
                }
              }}
            />
            <Button size="sm" onClick={() => onCommit(draft)} disabled={!canSave}>
              {tc('save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {tc('cancel')}
            </Button>
            {taken && (
              <p role="alert" className="w-full text-xs text-destructive">
                {t('sectionNameTaken')}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {/* The bar is the handle, not just the grip: only the listeners go
                here, so the grip keeps the role and the tab stop */}
            <span
              {...(disabled ? {} : listeners)}
              className={cn(
                'text-xs font-semibold text-foreground select-none',
                !disabled && 'cursor-grab touch-none'
              )}
            >
              {label}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRename}
              disabled={disabled}
              aria-label={t('renameSection')}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDissolve}
              disabled={disabled}
              aria-label={t('dissolveSection')}
            >
              <X />
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  )
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
  justRan,
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
  /** This row's run was started from here — see the badge's own prop. */
  justRan?: boolean
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
      {/* Indented rather than nested: the list is one column showing two
          levels, and the indent is what says which one a row is on. */}
      <TableCell className={cn(r.section && 'pl-8')}>{r.name || '-'}</TableCell>
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
            justRan={justRan}
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
  /** Runs that settled on the row whose editor is open.
   *
   *  A rebuild re-reads bytes that are already published, so unless the reading
   *  changed the create gate makes no version (`sameVersionIdentity`) and
   *  Interpret writes over the standing one's schema and preview in place.
   *  `latestVersion` does not move then, and the panels below have no other way
   *  to hear that what they are showing was rewritten. */
  const [editedRunsSettled, setEditedRunsSettled] = useState(0)

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

  // Which row's run the user just started. A run with nothing to do settles
  // before the refetch below sees it, so the badge is handed a finished run and
  // would say nothing about it (see PipelineStatusBadge.justRan).
  const [justRan, setJustRan] = useState<string | null>(null)

  // Staged order — committed via Save button
  const [items, setItems] = useState<Resource[]>(resources)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [pendings, setPendings] = useState<PendingSection[]>([])
  /** The heading whose name is being edited, by its sortable id — DRAFT_ID
   *  while a new section is being named at the end. */
  const [editingHeading, setEditingHeading] = useState<string | null>(null)
  const draftOpen = editingHeading === DRAFT_ID

  const isFormOpen = editId !== null || creating
  // One gate for every arrangement control: a rename must not watch rows move under it
  const controlsLocked =
    isFormOpen || savingOrder || dropUploads.length > 0 || editingHeading !== null

  useEffect(() => {
    setItems(resources)
    // A name the data now carries is drawn from the data: a row created into the
    // heading has arrived, or a refetch brought back the run it was lifted from
    const live = new Set(resources.map((r) => r.section))
    setPendings((list) => list.filter((p) => !live.has(p.name)))
  }, [resources])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Resources still uploading are shown as cards below the table — hide their
  // freshly-created rows so a mid-upload refetch doesn't show them twice
  const visibleItems = useMemo(
    () => items.filter((r) => !dropUploads.some((u) => u.resourceId === r.id)),
    [items, dropUploads]
  )
  // The table is where headings live, so an unsaved one needs it drawn too
  const showTable = visibleItems.length > 0 || creating || pendings.length > 0 || draftOpen

  /** Whether any label differs from what the server holds — the labels then go
   *  out whole with the order, so the later save wins whole (ADR-050). */
  const labelsChanged = useMemo(() => {
    const stored = new Map(resources.map((r) => [r.id, r.section ?? null]))
    return items.some((r) => stored.has(r.id) && (r.section ?? null) !== stored.get(r.id))
  }, [items, resources])

  const isDirty = useMemo(
    () =>
      (items.length === resources.length && items.some((r, i) => r.id !== resources[i]?.id)) ||
      labelsChanged,
    [items, resources, labelsChanged]
  )

  /** The list as drawn: one slot per row plus one past the end, each carrying
   *  the empty headings standing there and whether a section opens on its row. */
  const slots = useMemo(() => {
    const index = rowIndexById(visibleItems)
    const byIndex = new Map<number, PendingSection[]>()
    for (const p of pendings) {
      const i = anchorIndex(index, p.above, visibleItems.length)
      const bucket = byIndex.get(i)
      if (bucket) bucket.push(p)
      else byIndex.set(i, [p])
    }
    return [...visibleItems, null].map((row, i) => ({
      row,
      opens: row !== null && opensSection(visibleItems, i),
      pendingsHere: byIndex.get(i) ?? [],
    }))
  }, [visibleItems, pendings])

  /** Sortable ids in drawn order, so dnd-kit measures headings beside their rows. */
  const itemIds = useMemo(() => {
    const ids: string[] = []
    for (const slot of slots) {
      for (const p of slot.pendingsHere) ids.push(pendingDragId(p.id))
      if (slot.row) {
        if (slot.opens) ids.push(sectionDragId(slot.row.id))
        ids.push(slot.row.id)
      }
    }
    return ids
  }, [slots])

  // A heading can vanish under an open editor (a refetch relabelled or removed its
  // row); the editor must go with it, or the lock it holds has no way out
  useEffect(() => {
    if (editingHeading && editingHeading !== DRAFT_ID && !itemIds.includes(editingHeading)) {
      setEditingHeading(null)
    }
  }, [editingHeading, itemIds])

  type Dragged =
    | { kind: 'row'; index: number; label: string | null }
    | { kind: 'heading'; index: number; label: string }
    | { kind: 'pending'; index: number; label: string; pendingId: string }

  /** What a sortable id stands for, decoded once: its drawn index and label. */
  function resolveDrag(dragId: string): Dragged | null {
    if (isPendingDragId(dragId)) {
      const pendingId = pendingIdOfDragId(dragId)
      for (const [index, slot] of slots.entries()) {
        const p = slot.pendingsHere.find((p) => p.id === pendingId)
        if (p) return { kind: 'pending', index, label: p.name, pendingId }
      }
      return null
    }
    const index = visibleItems.findIndex((r) => r.id === rowIdOfDragId(dragId))
    if (index === -1) return null
    const label = visibleItems[index].section ?? null
    if (isSectionDragId(dragId)) return label ? { kind: 'heading', index, label } : null
    return { kind: 'row', index, label }
  }

  /** Whether naming a heading `name` would put that name in two places (ADR-050).
   *  A run is judged by the arrangement it makes, so renaming it to the name of
   *  the run next to it joins the two; an empty heading has no run to join. */
  function nameTaken(name: string, own: { runStart?: number; pendingId?: string }): boolean {
    if (pendings.some((p) => p.id !== own.pendingId && p.name === name)) return true
    const start = own.runStart
    if (start === undefined) return visibleItems.some((r) => r.section === name)
    const end = sectionRunEnd(visibleItems, start)
    const renamed = visibleItems.map((r, i) => (i >= start && i < end ? name : r.section))
    return splitSection(renamed) !== null
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = resolveDrag(String(active.id))
    const to = resolveDrag(String(over.id))
    if (!from || !to) return

    if (from.kind !== 'row') {
      // A heading is a divider: dragging it re-slices, and no row moves
      moveDivider(from, to)
      return
    }

    // Rows only drag while nothing is uploading, so the drawn list is the whole list
    const dropped = dropRow(visibleItems, from.index, to.index, to.kind !== 'row', to.label)
    setItems(dropped.rows)
    if (to.kind === 'pending') setPendings((list) => list.filter((p) => p.id !== to.pendingId))
    setReorderError(null)
  }

  /** The ids of the run starting at `from`, which a rename or dissolve rewrites. */
  function runIds(from: number) {
    return new Set(visibleItems.slice(from, sectionRunEnd(visibleItems, from)).map((r) => r.id))
  }

  function relabel(ids: Set<string>, section: string | null) {
    setItems((list) => list.map((r) => (ids.has(r.id) ? { ...r, section } : r)))
    setReorderError(null)
  }

  /** Set a divider down over `to` (ADR-050). One left with nothing under it is
   *  kept as an empty heading, so a name is not lost for a step too far. */
  function moveDivider(from: Exclude<Dragged, { kind: 'row' }>, to: Dragged) {
    const ontoHeading = to.kind !== 'row'
    const fromPendingId = from.kind === 'pending' ? from.pendingId : null
    const ontoPendingId = to.kind === 'pending' ? to.pendingId : null
    const placed = placeDivider(
      visibleItems,
      from.label,
      dividerLanding(from.index, to.index, ontoHeading),
      { lift: from.kind === 'heading' ? from.index : undefined, ontoHeading }
    )
    // Written back by id: hidden (uploading) rows keep their place and label
    const byId = new Map(placed.rows.map((r) => [r.id, r]))
    setItems((list) => list.map((r) => byId.get(r.id) ?? r))
    setPendings((list) => {
      const rest = fromPendingId ? list.filter((p) => p.id !== fromPendingId) : list
      if (placed.claimed > 0) return rest
      const heading = {
        id: fromPendingId ?? crypto.randomUUID(),
        name: from.label,
        above: visibleItems[placed.at]?.id ?? null,
      }
      // Above the heading it was dropped on, as it would stand above a saved one
      const at = rest.findIndex((p) => p.id === ontoPendingId)
      return at === -1 ? [...rest, heading] : rest.toSpliced(at, 0, heading)
    })
    setReorderError(null)
  }

  function startAddSection() {
    setEditingHeading(DRAFT_ID)
  }

  function commitHeading(dragId: string, raw: string) {
    const name = normalizeSection(raw)
    if (dragId === DRAFT_ID) {
      if (name) setPendings((list) => [...list, { id: crypto.randomUUID(), name, above: null }])
    } else if (name && isPendingDragId(dragId)) {
      const id = pendingIdOfDragId(dragId)
      setPendings((list) => list.map((p) => (p.id === id ? { ...p, name } : p)))
    } else if (name) {
      const from = resolveDrag(dragId)
      if (from) relabel(runIds(from.index), name)
    }
    setEditingHeading(null)
  }

  function cancelHeading() {
    setEditingHeading(null)
  }

  function cancelOrder() {
    setItems(resources)
    setPendings([])
    setEditingHeading(null)
    setReorderError(null)
  }

  async function saveOrder() {
    setSavingOrder(true)
    setReorderError(null)
    try {
      const res = await clientFetch(`/api/v1/packages/${packageId}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceIds: items.map((r) => r.id),
          // Labels ride with the order: a resource update would re-enqueue the pipeline (ADR-050)
          ...(labelsChanged && {
            sections: items.map((r) => ({ resourceId: r.id, section: r.section ?? null })),
          }),
        }),
      })
      if (!res.ok) {
        setReorderError((await problemDetail(res)) ?? t('reorderFailed'))
        return
      }
      onUpdated()
    } catch {
      setReorderError(t('reorderFailed'))
    } finally {
      setSavingOrder(false)
    }
  }

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
      file.size > MAX_UPLOAD_SIZE ? t('fileTooLarge', { size: MAX_UPLOAD_SIZE_MB }) : null
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
    if (u.resourceId) setJustRan(u.resourceId)
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
        // that it failed.
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
    // A new resource goes to the end, so it takes the level the end is on
    // (ADR-050) — spelled here rather than at each caller, because creating from
    // the form and dropping a file end up in the same place. The last row is
    // read from all rows: one still uploading is hidden from the drawn list,
    // and a heading anchored above it resolves to the drawn list's end slot.
    const trailing = slots.at(-1)?.pendingsHere.at(-1)?.name ?? items.at(-1)?.section ?? null
    const withSection = trailing ? { ...body, section: trailing } : body
    const run = createChain.current.then(() => createResource(withSection))
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
  function handleUploadComplete(resourceId: string) {
    setJustRan(resourceId)
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

  /** The heading of a section with nothing under it yet, wherever it stands. */
  function renderSectionHeading(
    dragId: string,
    label: string,
    onDissolve: () => void,
    isTaken: (name: string) => boolean
  ) {
    return (
      <SectionHeadingRow
        key={dragId}
        sortableId={dragId}
        label={label}
        editing={editingHeading === dragId}
        onCommit={(name) => commitHeading(dragId, name)}
        onCancel={cancelHeading}
        onRename={() => setEditingHeading(dragId)}
        onDissolve={onDissolve}
        isTaken={isTaken}
        disabled={controlsLocked}
      />
    )
  }

  function renderPending(p: PendingSection) {
    return (
      <Fragment key={p.id}>
        {renderSectionHeading(
          pendingDragId(p.id),
          p.name,
          () => setPendings((list) => list.filter((x) => x.id !== p.id)),
          (name) => nameTaken(name, { pendingId: p.id })
        )}
        {!creating && (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={COLUMN_COUNT}
              className="py-3 text-center text-xs text-muted-foreground"
            >
              {t('sectionEmpty')}
            </TableCell>
          </TableRow>
        )}
      </Fragment>
    )
  }

  function renderInlineForm() {
    if (uploadingResourceId) {
      return (
        <FileUploadZone
          resourceId={uploadingResourceId}
          initialFile={pendingFile ?? undefined}
          onComplete={() => handleUploadComplete(uploadingResourceId)}
        />
      )
    }

    const isUploadTab = formState.urlType === 'upload'
    // The form is open on a resource that already exists, not on a new one
    const isExistingResource = isEditing && !creating
    /** The row being edited, as the last refetch found it — the panels below
     *  are about the resource the server holds, not about the open form. */
    const edited = resources.find((r) => r.id === editId)
    /** What tells the two panels below their inputs moved. Two things do: a run
     *  storing a version, and a run rewriting the standing version's
     *  interpretation without storing one. Composed rather than summed — a
     *  purge lowers `latestVersion`, and a sum would sit still across a settle
     *  that happens to offset it. */
    const panelKey = `${edited?.latestVersion ?? 0}:${editedRunsSettled}`

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
                <Field id={`${isEditing ? 'edit' : 'create'}-url`}>
                  <FieldLabel>URL</FieldLabel>
                  <FieldControl>
                    <Input
                      value={formState.url}
                      onChange={(e) => handleUrlChange(e.target.value)}
                      placeholder="https://example.com/data.csv"
                    />
                  </FieldControl>
                </Field>
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
            <>
              {/* Only where rows exist to identify. A key is what a diff
                  matches rows by, and nothing but CSV/TSV is loaded row by row
                  — the same gate the preview uses to decide whether to offer a
                  table at all. Offered on a PDF it can only ever say there are
                  no columns, which is not news about a PDF.
                  The stored format, not the form's: everything below acts on
                  the resource as the server holds it, so a format being typed
                  and not yet saved must not make the section come and go. */}
              {isCsvFormat(edited?.format) && (
                <div className="mt-2 border-t pt-4">
                  {/* Above the history because settling a key creates a version:
                      what it does shows up in the list below it. */}
                  <PrimaryKeyPicker
                    resourceId={editId}
                    reloadKey={panelKey}
                    // A queued run reaches this screen the long way round: the
                    // refetch puts the row back as queued, the badge polls it,
                    // and its settling refetches again — which is what finally
                    // moves `latestVersion` and reloads the two panels below.
                    // Bumping them here instead would reload them while the run
                    // that changes them has not started.
                    onRunQueued={() => {
                      setJustRan(editId)
                      scheduleRefetch()
                    }}
                  />
                </div>
              )}
              <div className="mt-2 border-t pt-4">
                {/* Moves when a run changed what is listed here, and not on
                    every refresh of the package. */}
                <ResourceVersionHistory resourceId={editId} reloadKey={panelKey} />
              </div>
            </>
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
      {!showTable && dropUploads.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('noResources')}</p>
      )}
      {showTable && (
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
                {slots.map(({ row: r, opens, pendingsHere }, i) => (
                  <Fragment key={r?.id ?? 'end'}>
                    {pendingsHere.map(renderPending)}
                    {r &&
                      opens &&
                      renderSectionHeading(
                        sectionDragId(r.id),
                        r.section as string,
                        () => relabel(runIds(i), null),
                        (name) => nameTaken(name, { runStart: i })
                      )}
                    {r && (
                      <SortableResourceRow
                        resource={r}
                        packageName={packageName}
                        isDragDisabled={controlsLocked}
                        isActionsDisabled={isDirty || savingOrder}
                        isActive={editId === r.id}
                        onEdit={startEdit}
                        onClose={resetForm}
                        // A settle means the row's status (and maybe others)
                        // changed — refresh through the retrying gate
                        onPipelineSettled={() => {
                          scheduleRefetch()
                          if (r.id === editId) setEditedRunsSettled((n) => n + 1)
                        }}
                        justRan={justRan === r.id}
                      />
                    )}
                    {r && activeFormId === r.id && (
                      <TableRow>
                        <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30 p-4">
                          {renderInlineForm()}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
                {draftOpen &&
                  renderSectionHeading(DRAFT_ID, '', cancelHeading, (name) => nameTaken(name, {}))}
              </SortableContext>
              {creating && (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30 p-4">
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={startCreate}
            disabled={isDirty || savingOrder}
          >
            <Plus className="mr-1 size-4" />
            {t('addResource')}
          </Button>
          <Button variant="outline" size="sm" onClick={startAddSection} disabled={controlsLocked}>
            <Plus className="mr-1 size-4" />
            {t('addSection')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('sectionHint')}</span>
        </div>
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
