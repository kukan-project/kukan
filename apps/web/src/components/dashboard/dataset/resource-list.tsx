'use client'

import { Fragment, useState, useRef, useEffect, useMemo } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from '@kukan/ui'
import { X, Plus, GripVertical, Pencil } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  detectFormat,
  normalizeSection,
  splitSection,
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_MB,
  JSON_PREVIEW_LIMIT_MB,
  OFFICE_PREVIEW_LIMIT_MB,
  TEXT_PREVIEW_LIMIT_MB,
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
import { clientFetch, readProblem } from '@/lib/client-api'
import { useProblemMessage } from '@/hooks/use-problem-message'
import { takePendingDropFiles } from '@/lib/pending-drop-files'
import { resourceEditPath } from '@/lib/paths'
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
import { PipelineStatusBadge } from './pipeline-status-badge'
import { DropFilesZone } from './drop-files-zone'
import { FileUploadZone } from './file-upload-zone'
import { ResourceFormFields } from './resource-form-fields'
import { ResourceSourceTabs } from './resource-source-tabs'
import { ExtrasFields, snapshotExtras, useExtrasRows } from './extras-fields'
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
  /** A version whose reading waits on a person (ii-c §8.4) */
  typeReviewDue?: boolean
  section?: string | null
  extras?: Record<string, unknown> | null
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
  resources: Resource[]
  /** Where a row leads; the resource's own page in the editor unless told (ADR-072) */
  hrefFor?: (resourceId: string) => string
  /** The resource whose page is open, drawn as selected */
  activeId?: string | null
  /** A deleted dataset: its resources are shown, not opened or arranged */
  readOnly?: boolean
  /** Refetch the parent's package; return false when the refresh could not
   *  be applied — the list then keeps its busy gate up and retries */
  onUpdated: () => void | boolean | Promise<void | boolean>
  /** Reports whether any file upload is still in flight (ADR-040) */
  onUploadingChange?: (uploading: boolean) => void
  /** Reports whether an order or section labels are staged and not saved */
  onDirtyChange?: (dirty: boolean) => void
}

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
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      // Tinted with the brand colour rather than the neutral grey a hovered row
      // takes, so a heading and a hovered row cannot be mistaken for each other
      className="mt-2 flex items-start gap-1 rounded-md bg-primary/10 py-1 pr-1"
    >
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
      <div className="min-w-0 flex-1 py-0.5">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              value={draft}
              aria-label={t('sectionName')}
              placeholder={t('sectionNamePlaceholder')}
              className="h-8"
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
                'min-w-0 flex-1 truncate text-xs font-semibold text-foreground select-none',
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
      </div>
    </div>
  )
}

function SortableResourceRow({
  resource: r,
  href,
  isDragDisabled,
  isActive,
  readOnly,
  onPipelineSettled,
  justRan,
}: {
  resource: Resource
  href: string
  isDragDisabled: boolean
  /** This resource's page is the one open */
  isActive: boolean
  readOnly: boolean
  onPipelineSettled?: () => void
  /** This row's run was started from here — see the badge's own prop. */
  justRan?: boolean
}) {
  const tc = useTranslations('common')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: r.id,
    disabled: isDragDisabled,
  })

  // The badge inline at the head of the first line, so a second line runs from
  // the left edge rather than under a column the badge keeps empty. Two lines
  // before it is cut: names that share a long prefix differ near their end.
  // The whole name on hover.
  const body = (
    <span className="line-clamp-2 min-w-0 flex-1 break-words" title={r.name || undefined}>
      {/* The public list's badge, so a format reads the same on both sides */}
      {r.format ? (
        <FormatBadge format={r.format} className="mr-2 min-w-[48px] text-center align-middle" />
      ) : (
        <span className="mr-2 inline-block min-w-[48px] text-center text-xs text-muted-foreground">
          -
        </span>
      )}
      {r.name || '-'}
    </span>
  )

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(
        'flex items-center gap-1 rounded-md pr-2 text-sm',
        isActive ? 'bg-accent font-medium' : 'hover:bg-accent/60'
      )}
    >
      {!readOnly && (
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
      )}
      {/* Not indented: a row outside every section can only stand above the
          first heading (ADR-050), so the tinted heading bars say which rows a
          section holds, and the narrow column keeps the width for the name */}
      {readOnly ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 py-1.5">{body}</span>
      ) : (
        <Link
          href={href}
          aria-current={isActive ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5"
        >
          {body}
        </Link>
      )}
      {r.pipelineStatus && (
        <PipelineStatusBadge
          variant="dot"
          resourceId={r.id}
          initialStatus={r.pipelineStatus}
          onSettled={onPipelineSettled}
          justRan={justRan}
          reviewDue={r.typeReviewDue}
        />
      )}
    </div>
  )
}

/** Whether two lists put the rows in a different order or under different labels */
function arrangementDiffers(a: readonly Resource[], b: readonly Resource[]): boolean {
  return (
    a.length !== b.length ||
    a.some((r, i) => r.id !== b[i].id || (r.section ?? null) !== (b[i].section ?? null))
  )
}

export function ResourceList({
  packageId,
  resources,
  hrefFor = (resourceId) => resourceEditPath(packageId, resourceId),
  activeId = null,
  readOnly = false,
  onUpdated,
  onUploadingChange,
  onDirtyChange,
}: ResourceListProps) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const td = useTranslations('dataset')
  const describeProblem = useProblemMessage()

  // The create form (a resource's own fields are edited on its page, ADR-072)
  const [creating, setCreating] = useState(false)
  const [formState, setFormState] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const extrasEditor = useExtrasRows()
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [uploadingResourceId, setUploadingResourceId] = useState<string | null>(null)

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

  // One gate for every arrangement control: a rename must not watch rows move under it
  const controlsLocked =
    readOnly || creating || savingOrder || dropUploads.length > 0 || editingHeading !== null

  // What the last copy of the data said, to tell a staged arrangement from one
  // the server sent
  const lastResources = useRef(resources)
  useEffect(() => {
    const before = lastResources.current
    lastResources.current = resources
    // A staged order is kept across a refetch — a save on a resource's page
    // reads the dataset back, and taking that copy whole would undo the
    // arrangement being made here. The rows' own fields still come fresh;
    // their order and labels stay as staged until saved or cancelled.
    setItems((staged) => {
      if (!arrangementDiffers(staged, before)) return resources
      const fresh = new Map(resources.map((r) => [r.id, r]))
      const kept = staged
        .filter((r) => fresh.has(r.id))
        .map((r) => ({ ...fresh.get(r.id)!, section: r.section }))
      const added = resources.filter((r) => !staged.some((x) => x.id === r.id))
      return [...kept, ...added]
    })
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
  // A heading being typed, or one waiting for a row to join it, is unsaved work
  // too, though neither moves the order or a stored label yet — and so is a
  // resource being filled in on the add dialog
  const draftingResource =
    creating &&
    (!!pendingFile ||
      JSON.stringify(formState) !== JSON.stringify(emptyForm) ||
      snapshotExtras(extrasEditor.rows) !== snapshotExtras([]))
  const unsaved = isDirty || pendings.length > 0 || editingHeading !== null || draftingResource
  useEffect(() => {
    onDirtyChange?.(unsaved)
  }, [unsaved, onDirtyChange])

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
          // Labels ride with the order, settled in the same transaction (ADR-050)
          ...(labelsChanged && {
            sections: items.map((r) => ({ resourceId: r.id, section: r.section ?? null })),
          }),
        }),
      })
      if (!res.ok) {
        setReorderError(describeProblem(await readProblem(res)) ?? t('reorderFailed'))
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

  /** Open or close the create form, empty either way */
  function setCreateOpen(open: boolean) {
    setCreating(open)
    setFormState(emptyForm)
    extrasEditor.reset()
    setFormError(null)
    setPendingFile(null)
    setUploadingResourceId(null)
  }

  function resetForm() {
    setCreateOpen(false)
  }

  function startCreate() {
    setCreateOpen(true)
  }

  // --- Drop-to-create ---

  // Dropping while a form is open or a reorder is pending would be ambiguous
  const dropEnabled = !creating && !isDirty && !savingOrder

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

  // --- Create ---

  /** POST a new resource; throws with the server's problem detail on failure */
  async function createResource(body: Record<string, unknown>): Promise<Resource> {
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
    if (!res.ok) throw new Error(describeProblem(await readProblem(res)) ?? t('failedToAdd'))
    return res.json()
  }

  // All creations (drop and form) go through one queue so this tab's creates
  // don't interleave and dropped files keep their drop order as positions.
  // Cross-client position races are handled server-side (advisory lock in
  // ResourceService.create()). Uploads themselves stay parallel.
  function enqueueCreate(body: Record<string, unknown>): Promise<Resource> {
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
    const extras = extrasEditor.build()
    if (!extras) return
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

      const resource = await enqueueCreate({ ...body, extras })
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
    resetForm()
  }

  // --- Create form ---

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
          <p className="py-2 pl-7 text-xs text-muted-foreground">{t('sectionEmpty')}</p>
        )}
      </Fragment>
    )
  }

  function renderCreateForm() {
    if (uploadingResourceId) {
      return (
        <FileUploadZone
          resourceId={uploadingResourceId}
          initialFile={pendingFile ?? undefined}
          format={formState.format || undefined}
          onComplete={() => handleUploadComplete(uploadingResourceId)}
        />
      )
    }

    return (
      <>
        {formError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-4">
          <ResourceFormFields
            idPrefix="create"
            name={formState.name}
            onNameChange={(v) => setFormState((s) => ({ ...s, name: v }))}
            format={formState.format}
            onFormatChange={(v) => setFormState((s) => ({ ...s, format: v }))}
            description={formState.description}
            onDescriptionChange={(v) => setFormState((s) => ({ ...s, description: v }))}
          >
            <ResourceSourceTabs
              idPrefix="create"
              urlType={formState.urlType}
              url={formState.url}
              file={pendingFile}
              onTypeChange={(urlType) => setFormState((s) => ({ ...s, urlType }))}
              onUrlChange={(url) => setFormState((s) => ({ ...s, url }))}
              onFileChange={setPendingFile}
              onFormatDetected={(format) => setFormState((s) => ({ ...s, format }))}
            />
          </ResourceFormFields>
          <ExtrasFields editor={extrasEditor} />
          <div className="flex gap-2">
            <Button
              onClick={handleCreate}
              disabled={saving || (formState.urlType === 'upload' && !pendingFile)}
            >
              {saving ? t('addingResource') : t('addResource')}
            </Button>
            <Button variant="ghost" onClick={resetForm} disabled={saving}>
              {tc('cancel')}
            </Button>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-2" {...(readOnly ? {} : dropHandlers)}>
      {reorderError && (
        <Alert variant="destructive">
          <AlertDescription>{reorderError}</AlertDescription>
        </Alert>
      )}
      {isDirty && (
        <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
          <span className="text-muted-foreground">{t('reorderPending')}</span>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveOrder} disabled={savingOrder}>
              {savingOrder ? tc('updating') : t('saveOrder')}
            </Button>
            <Button variant="outline" size="sm" onClick={cancelOrder} disabled={savingOrder}>
              {tc('cancel')}
            </Button>
          </div>
        </div>
      )}
      {!showTable && dropUploads.length === 0 && (
        <p className="px-2 py-2 text-xs text-muted-foreground">{t('noResources')}</p>
      )}
      {showTable && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
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
                      href={hrefFor(r.id)}
                      isDragDisabled={controlsLocked}
                      isActive={activeId === r.id}
                      readOnly={readOnly}
                      // A settle means the row's status (and maybe others)
                      // changed — refresh through the retrying gate
                      onPipelineSettled={() => scheduleRefetch()}
                      justRan={justRan === r.id}
                    />
                  )}
                </Fragment>
              ))}
              {draftOpen &&
                renderSectionHeading(DRAFT_ID, '', cancelHeading, (name) => nameTaken(name, {}))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {dropUploads.map((u) => (
        <div key={u.key} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'min-w-0 truncate text-xs',
                u.error ? 'text-destructive' : 'text-muted-foreground'
              )}
              title={u.file.name}
            >
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

      {!readOnly && dropEnabled && (
        <DropFilesZone
          hint={t('dropHint')}
          active={dropActive}
          onFiles={(files) => {
            for (const file of files) startDropUpload(file)
          }}
        />
      )}

      {!readOnly && (
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
        </div>
      )}

      {/* Too wide for the left column: the new resource's fields open over the page */}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (open || saving) return
          // Closed with an upload begun: the resource exists, so read the list
          // back to show it — the upload may have been cancelled or failed,
          // and the zone has no way out of its own
          const created = uploadingResourceId
          resetForm()
          if (created) scheduleRefetch()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('addResource')}</DialogTitle>
            <DialogDescription>
              {td('resourcesPreviewLimits', {
                officeMb: OFFICE_PREVIEW_LIMIT_MB,
                jsonMb: JSON_PREVIEW_LIMIT_MB,
                textMb: TEXT_PREVIEW_LIMIT_MB,
              })}
            </DialogDescription>
          </DialogHeader>
          {renderCreateForm()}
        </DialogContent>
      </Dialog>
    </div>
  )
}
