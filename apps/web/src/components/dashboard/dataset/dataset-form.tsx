'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  createPackageSchema,
  draftPublishBlockers,
  isDraftPlaceholderName,
  LICENSES,
  resolveLicenseLabel,
  type DraftPublishBlocker,
} from '@kukan/shared'
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  badgeVariants,
  cn,
} from '@kukan/ui'
import { Sparkles } from 'lucide-react'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { draftEditPath } from '@/lib/paths'
import { updateResource } from '@/lib/update-resource'
import { parseTags } from '@/lib/parse-tags'
import {
  MetadataSuggestDialog,
  type SuggestResourceInfo,
  type SuggestSelection,
} from './metadata-suggest-dialog'

/** Form-level schema: licenseId is required in the UI */
const datasetFormSchema = createPackageSchema.extend({
  licenseId: z.string().min(1),
})

/** Draft form schema: name/ownerOrg/licenseId may stay unset until publish (ADR-039) */
const draftFormSchema = datasetFormSchema.extend({
  name: z.union([createPackageSchema.shape.name, z.literal('')]).optional(),
  ownerOrg: z.union([z.uuid(), z.literal('')]).optional(),
  licenseId: z.string().optional(),
})
type DatasetFormInput = z.infer<typeof draftFormSchema>

/**
 * Normalized snapshots of the fields managed outside React Hook Form, used to
 * detect changes the same way the submit payload is built (empty extras keys
 * are ignored, group order is irrelevant).
 */
const snapshotGroups = (names: string[]) => [...names].sort().join('\n')
const snapshotExtras = (rows: { key: string; value: string }[]) =>
  JSON.stringify(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]))

interface Organization {
  id: string
  name: string
  title?: string
}

interface GroupOption {
  id: string
  name: string
  title?: string | null
}

interface DatasetFormProps {
  mode: 'create' | 'edit'
  defaultValues?: Partial<DatasetFormInput>
  nameOrId?: string
  organizations: Organization[]
  /** Edit target is a draft package (ADR-039): partial PUT, relaxed validation */
  isDraft?: boolean
  /** Called after a successful update instead of navigating to the list */
  onSaved?: () => void
  /** Called after "Save & Publish" successfully published the draft */
  onPublished?: () => void
  /** Blocks submission from outside (e.g. while the page's drop-create runs) */
  disabled?: boolean
  /** Reports the form's own in-flight submission for page-level exclusion */
  onBusyChange?: (busy: boolean) => void
  /** AI metadata suggestions (ADR-040); absent = feature hidden */
  suggest?: {
    /** Site capability (null while loading — button hidden until known) */
    enabled: boolean | null
    resources: SuggestResourceInfo[]
    /** Uploads or pipelines still running — keeps the button disabled */
    processing?: boolean
    /** Increment to open the dialog from outside (pipeline-complete nudge) */
    openSignal?: number
    /** Called after adopted resource descriptions were saved */
    onResourcesUpdated?: () => void
  }
}

export function DatasetForm({
  mode,
  defaultValues,
  nameOrId,
  organizations,
  isDraft,
  onSaved,
  onPublished,
  disabled,
  onBusyChange,
  suggest,
}: DatasetFormProps) {
  // Creation always starts as a draft (ADR-039)
  const isDraftMode = mode === 'create' || !!isDraft
  const router = useRouter()
  const t = useTranslations('dataset')
  const tl = useTranslations('license')
  const tc = useTranslations('common')
  const [error, setError] = useState<string | null>(null)
  const [extrasError, setExtrasError] = useState<string | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  // Which footer button is in flight, for the loading labels
  const [publishIntent, setPublishIntent] = useState(false)
  const [tagsInput, setTagsInput] = useState(
    defaultValues?.tags?.map((t) => t.name).join(', ') ?? ''
  )
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([])
  const [selectedGroups, setSelectedGroups] = useState<string[]>(
    defaultValues?.groups?.map((g) => g.name) ?? []
  )
  // Whether the server holds a real (non-placeholder) name: clearing it must
  // send an explicit `name: null` to reset the draft to a fresh placeholder,
  // while an already-blank placeholder name is simply omitted (ADR-039)
  const serverHasRealName = useRef(!!defaultValues?.name)

  useEffect(() => {
    clientFetch('/api/v1/groups?limit=100').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setGroupOptions(data.items)
      }
    })
  }, [])

  const toggleGroup = useCallback((name: string) => {
    setSelectedGroups((names) =>
      names.includes(name) ? names.filter((n) => n !== name) : [...names, name]
    )
  }, [])
  const nextExtrasId = useRef(0)
  const [extrasRows, setExtrasRows] = useState<{ id: number; key: string; value: string }[]>(() => {
    const extras = (defaultValues?.extras ?? {}) as Record<string, unknown>
    return Object.entries(extras).map(([key, value]) => {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value ?? '')
      return { id: nextExtrasId.current++, key, value: strValue }
    })
  })

  const addExtrasRow = useCallback(() => {
    setExtrasRows((rows) => [...rows, { id: nextExtrasId.current++, key: '', value: '' }])
  }, [])

  const removeExtrasRow = useCallback((id: number) => {
    setExtrasRows((rows) => rows.filter((r) => r.id !== id))
    setExtrasError(null)
  }, [])

  const updateExtrasRow = useCallback((id: number, field: 'key' | 'value', val: string) => {
    setExtrasRows((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }, [])

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<DatasetFormInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(isDraftMode ? draftFormSchema : datasetFormSchema) as any,
    defaultValues: {
      private: false,
      type: 'dataset',
      extras: {},
      tags: [],
      resources: [],
      ...defaultValues,
    },
  })

  const isDraftEdit = mode === 'edit' && isDraftMode

  // Set on successful submit right before router.push and never cleared — the
  // page unmounts. isSubmitting alone would drop back to false while the
  // navigation is still in flight, re-enabling the owner's competing actions
  const [navigating, setNavigating] = useState(false)

  useEffect(() => {
    onBusyChange?.(isSubmitting || navigating)
  }, [isSubmitting, navigating, onBusyChange])

  // --- AI metadata suggestions (ADR-040) ---
  const [suggestOpen, setSuggestOpen] = useState(false)
  // Counter, not a boolean: overlapping applies must all finish before the
  // save/publish block lifts (a boolean would clear on the first one's finally)
  const [applyingCount, setApplyingCount] = useState(0)
  const applyingResources = applyingCount > 0
  const [resourceApplyError, setResourceApplyError] = useState<string | null>(null)
  const showSuggest = mode === 'edit' && !!nameOrId && suggest?.enabled === true
  const hasCompleteResource = suggest?.resources.some((r) => r.pipelineStatus === 'complete')
  // Wait for every upload/pipeline — an early suggestion would miss the rest
  const suggestReady = !!hasCompleteResource && !suggest?.processing

  // The pipeline-complete nudge (edit page) opens the dialog via a counter prop.
  // Open only when the counter changes after mount — not for the value present at
  // mount, or publishing (which remounts this form via key) would reopen a stale one.
  const openSignal = suggest?.openSignal
  const lastOpenSignal = useRef(openSignal)
  useEffect(() => {
    if (openSignal !== lastOpenSignal.current) {
      lastOpenSignal.current = openSignal
      if (openSignal) setSuggestOpen(true)
    }
  }, [openSignal])

  const applySuggestion = (selection: SuggestSelection) => {
    if (selection.title !== undefined) setValue('title', selection.title, { shouldDirty: true })
    if (selection.notes !== undefined) setValue('notes', selection.notes, { shouldDirty: true })
    const nextTagsInput = selection.tags ? selection.tags.join(', ') : undefined
    if (nextTagsInput !== undefined) setTagsInput(nextTagsInput)
    if (selection.groups) setSelectedGroups(selection.groups)
    if (selection.name !== undefined) setValue('name', selection.name, { shouldDirty: true })
    // Adopting is the confirmation — save the dataset fields right away. On a
    // validation failure nothing is sent; the adopted values stay in the form
    // and the user saves manually after fixing the errors
    const datasetAdopted =
      selection.title !== undefined ||
      selection.notes !== undefined ||
      selection.tags !== undefined ||
      selection.groups !== undefined ||
      selection.name !== undefined
    if (datasetAdopted) {
      void handleSubmit((values) =>
        onSubmit(values, false, { tagsInput: nextTagsInput, groups: selection.groups })
      )()
    }
    if (selection.resources?.length) {
      // Adopting a resource name/description is an ordinary resource update,
      // saved immediately (the form has no state for resources). Block save /
      // publish while it runs (a concurrent publish could race the writes), and
      // surface any failure instead of silently closing as if it succeeded.
      setResourceApplyError(null)
      setApplyingCount((n) => n + 1)
      void (async () => {
        try {
          const results = await Promise.all(
            selection.resources!.map((item) =>
              updateResource(item.id, {
                ...(item.name !== undefined && { name: item.name }),
                ...(item.description !== undefined && { description: item.description }),
              })
            )
          )
          const failed = results.filter((ok) => !ok).length
          if (failed > 0)
            setResourceApplyError(t('aiSuggestResourceApplyFailed', { count: failed }))
        } catch {
          setResourceApplyError(
            t('aiSuggestResourceApplyFailed', { count: selection.resources!.length })
          )
        } finally {
          setApplyingCount((n) => n - 1)
          suggest?.onResourcesUpdated?.()
        }
      })()
    }
  }

  // Tags/groups/extras live outside RHF, so isDirty alone misses them: keep a
  // baseline snapshot (refreshed on save) and compare
  const [baseline, setBaseline] = useState(() => ({
    tags: tagsInput,
    groups: snapshotGroups(selectedGroups),
    extras: snapshotExtras(extrasRows),
  }))
  const hasChanges =
    isDirty ||
    tagsInput !== baseline.tags ||
    snapshotGroups(selectedGroups) !== baseline.groups ||
    snapshotExtras(extrasRows) !== baseline.extras

  // Live publish preconditions (ADR-039): judge on the current form values so
  // "Save & Publish" enables without a save round-trip. A blank name field
  // means the server keeps (or regenerates) the placeholder, so substitute a
  // placeholder-shaped name to surface the name blocker.
  const [liveName, liveOwnerOrg, liveLicenseId] = watch(['name', 'ownerOrg', 'licenseId'])
  const publishBlockers = isDraftEdit
    ? draftPublishBlockers({
        name: liveName || 'untitled-00000000',
        ownerOrg: liveOwnerOrg || null,
        licenseId: liveLicenseId || null,
      })
    : []
  const blockerMessages: Record<DraftPublishBlocker, string> = {
    name: t('publishRequiresName'),
    org: t('publishRequiresOrg'),
    license: t('publishRequiresLicense'),
  }

  /** `adopt` marks a save triggered by adopting AI suggestions: it carries the
   *  just-set tags/groups (React state is still stale here) and keeps the user
   *  on the page afterwards */
  const onSubmit = async (
    values: DatasetFormInput,
    publishAfter = false,
    adopt?: { tagsInput?: string; groups?: string[] }
  ) => {
    setError(null)
    setPublishError(null)
    setPublishIntent(publishAfter)
    const effectiveTagsInput = adopt?.tagsInput ?? tagsInput
    const effectiveGroups = adopt?.groups ?? selectedGroups

    // Saved values become the new pristine state
    const refreshBaseline = () =>
      setBaseline({
        tags: effectiveTagsInput,
        groups: snapshotGroups(effectiveGroups),
        extras: snapshotExtras(extrasRows),
      })

    // Parse comma-separated tags
    const tags = parseTags(effectiveTagsInput).map((name) => ({ name }))

    // Build extras from key-value rows (skip empty keys)
    const filledRows = extrasRows.filter((r) => r.key.trim())
    const keyCount = new Map<string, number>()
    for (const r of filledRows) {
      const k = r.key.trim()
      keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
    }
    const duplicateKeys = [...keyCount.entries()].filter(([, c]) => c > 1).map(([k]) => k)
    if (duplicateKeys.length > 0) {
      setExtrasError(t('extrasDuplicateKey', { keys: duplicateKeys.join(', ') }))
      return
    }
    setExtrasError(null)
    const extras = Object.fromEntries(filledRows.map((r) => [r.key.trim(), r.value]))

    const groups = effectiveGroups.map((name) => ({ name }))

    const body: Record<string, unknown> = { ...values, tags, groups, extras }
    if (isDraftMode) {
      // Unset name/ownerOrg stay server-managed (placeholder / null) — omit
      // rather than send '' (draft PUT is partial: absent keys are untouched).
      // Exception: clearing a previously set real name sends `name: null` so
      // the server regenerates the placeholder (ADR-039)
      if (!values.name) {
        if (mode === 'edit' && serverHasRealName.current) body.name = null
        else delete body.name
      }
      if (!values.ownerOrg) delete body.ownerOrg
    }

    const url = mode === 'create' ? '/api/v1/packages/drafts' : `/api/v1/packages/${nameOrId}`
    const method = mode === 'create' ? 'POST' : 'PUT'

    const res = await clientFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || tc('failedToCreate'))
      return
    }

    if (mode === 'create') {
      // Continue as a draft: add resources, then publish from the edit page
      const created = await res.json()
      setNavigating(true)
      router.push(draftEditPath(created.id))
      return
    }

    if (isDraftMode) {
      // Re-show the server-side name/ownerOrg to match the publish
      // preconditions: an omitted blank field keeps its previous value, an
      // explicit `name: null` came back as a fresh placeholder (shown blank)
      const saved = await res.json()
      serverHasRealName.current = !isDraftPlaceholderName(saved.name)
      reset({
        ...values,
        name: isDraftPlaceholderName(saved.name) ? '' : saved.name,
        ownerOrg: saved.ownerOrg ?? '',
      })
      refreshBaseline()

      if (publishAfter) {
        const pubRes = await clientFetch(`/api/v1/packages/${nameOrId}/publish`, {
          method: 'POST',
        })
        if (!pubRes.ok) {
          // The save itself landed — say so, and keep the draft editable
          const data = await pubRes.json().catch(() => ({}))
          setPublishError(t('savedButPublishFailed', { detail: data.detail || t('publishFailed') }))
          onSaved?.()
          return
        }
        onPublished?.()
        return
      }
    }

    if (!isDraftMode) {
      // Back to pristine: the Save button disables until the next change
      reset(values)
      refreshBaseline()
    }

    if (onSaved) {
      onSaved()
    } else if (!adopt) {
      // An adopt-save keeps the user editing; only an explicit save navigates
      setNavigating(true)
      router.push('/dashboard/datasets')
    }
  }

  return (
    <form onSubmit={handleSubmit((values) => onSubmit(values))} className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {showSuggest && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setSuggestOpen(true)}
            disabled={!suggestReady || applyingResources}
          >
            <Sparkles className="mr-1 size-4" />
            {t('aiSuggestButton')}
          </Button>
          {suggest?.processing ? (
            <span className="text-xs text-muted-foreground">{t('aiSuggestProcessing')}</span>
          ) : (
            !hasCompleteResource && (
              <span className="text-xs text-muted-foreground">{t('aiSuggestNeedResources')}</span>
            )
          )}
          {applyingResources && (
            <span className="text-xs text-muted-foreground">{t('aiSuggestApplyingResources')}</span>
          )}
        </div>
      )}

      {resourceApplyError && (
        <Alert variant="destructive">
          <AlertDescription>{resourceApplyError}</AlertDescription>
        </Alert>
      )}

      {showSuggest && nameOrId && (
        <MetadataSuggestDialog
          nameOrId={nameOrId}
          open={suggestOpen}
          onOpenChange={setSuggestOpen}
          current={{
            title: watch('title') ?? '',
            notes: watch('notes') ?? '',
            tags: parseTags(tagsInput),
            groups: selectedGroups,
            name: watch('name') ?? '',
            resources: suggest?.resources ?? [],
          }}
          groupOptions={groupOptions}
          onApply={applySuggestion}
        />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{isDraftMode ? tc('urlIdentifier') : tc('nameRequired')}</Label>
        <Input
          id="name"
          placeholder="my-dataset"
          {...register('name')}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'name-help name-error' : 'name-help'}
          disabled={!isDraftMode}
        />
        <p id="name-help" className="text-xs text-muted-foreground">
          {tc('nameHelp')}
          {isDraftMode && ` ${t('draftNameHelp')}`}
        </p>
        {errors.name && (
          <p id="name-error" className="text-sm text-destructive">
            {errors.name.message}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">{tc('title')}</Label>
        <Input id="title" placeholder={t('titlePlaceholder')} {...register('title')} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">{tc('description')}</Label>
        <Textarea
          id="notes"
          placeholder={t('descriptionPlaceholder')}
          rows={4}
          {...register('notes')}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ownerOrg">{isDraftMode ? tc('organization') : t('orgRequired')}</Label>
        <Controller
          name="ownerOrg"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger
                aria-invalid={!!errors.ownerOrg}
                aria-describedby={errors.ownerOrg ? 'ownerOrg-error' : undefined}
              >
                <SelectValue placeholder={t('orgSelect')} />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.title || org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.ownerOrg && (
          <p id="ownerOrg-error" className="text-sm text-destructive">
            {tc('required')}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Controller
          name="private"
          control={control}
          render={({ field }) => (
            <Switch id="private" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
        <Label htmlFor="private">{tc('private')}</Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="tags">{t('tags')}</Label>
        <Input
          id="tags"
          placeholder={t('tagsPlaceholder')}
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('tagsHelp')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t('categories')}</Label>
        {groupOptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noCategoriesAvailable')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {groupOptions.map((g) => {
                const selected = selectedGroups.includes(g.name)
                return (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleGroup(g.name)}
                    className={cn(
                      badgeVariants({ variant: selected ? 'default' : 'outline' }),
                      'cursor-pointer'
                    )}
                  >
                    {g.title || g.name}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t('categoriesHelp')}</p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>{isDraftMode ? tc('license') : t('licenseRequired')}</Label>
        <Controller
          name="licenseId"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger
                aria-invalid={!!errors.licenseId}
                aria-describedby={errors.licenseId ? 'licenseId-error' : undefined}
              >
                <SelectValue placeholder={t('licenseSelect')} />
              </SelectTrigger>
              <SelectContent>
                {LICENSES.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {resolveLicenseLabel(l.id, tl)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.licenseId && (
          <p id="licenseId-error" className="text-sm text-destructive">
            {tc('required')}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="author">{t('author')}</Label>
          <Input id="author" {...register('author')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="authorEmail">{t('authorEmail')}</Label>
          <Input
            id="authorEmail"
            type="email"
            {...register('authorEmail')}
            aria-invalid={!!errors.authorEmail}
            aria-describedby={errors.authorEmail ? 'authorEmail-error' : undefined}
          />
          {errors.authorEmail && (
            <p id="authorEmail-error" className="text-sm text-destructive">
              {errors.authorEmail.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainer">{t('maintainerLabel')}</Label>
          <Input id="maintainer" {...register('maintainer')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainerEmail">{t('maintainerEmail')}</Label>
          <Input
            id="maintainerEmail"
            type="email"
            {...register('maintainerEmail')}
            aria-invalid={!!errors.maintainerEmail}
            aria-describedby={errors.maintainerEmail ? 'maintainerEmail-error' : undefined}
          />
          {errors.maintainerEmail && (
            <p id="maintainerEmail-error" className="text-sm text-destructive">
              {errors.maintainerEmail.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="url">URL</Label>
          <Input
            id="url"
            type="url"
            placeholder="https://example.com"
            {...register('url')}
            aria-invalid={!!errors.url}
            aria-describedby={errors.url ? 'url-error' : undefined}
          />
          {errors.url && (
            <p id="url-error" className="text-sm text-destructive">
              {errors.url.message}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="version">{t('version')}</Label>
          <Input id="version" placeholder="1.0" {...register('version')} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t('extras')}</Label>
        <p className="text-xs text-muted-foreground">{t('extrasHelp')}</p>
        {extrasRows.map((row) => (
          <div key={row.id} className="flex gap-2">
            <Input
              placeholder={t('extrasKeyPlaceholder')}
              value={row.key}
              onChange={(e) => updateExtrasRow(row.id, 'key', e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder={t('extrasValuePlaceholder')}
              value={row.value}
              onChange={(e) => updateExtrasRow(row.id, 'value', e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeExtrasRow(row.id)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addExtrasRow}>
          {t('extrasAdd')}
        </Button>
        {extrasError && <p className="text-sm text-destructive">{extrasError}</p>}
      </div>

      {isDraftEdit ? (
        <div className="flex flex-col gap-3">
          {publishBlockers.length > 0 && (
            <ul className="list-inside list-disc text-sm text-warning-tint-foreground">
              {publishBlockers.map((b) => (
                <li key={b}>{blockerMessages[b]}</li>
              ))}
            </ul>
          )}
          {publishError && (
            <Alert variant="destructive">
              <AlertDescription>{publishError}</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-3">
            <Button
              type="submit"
              variant="outline"
              className="flex-1"
              disabled={disabled || isSubmitting || navigating || !hasChanges || applyingResources}
            >
              {isSubmitting && !publishIntent ? tc('saving') : t('saveDraft')}
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={
                disabled ||
                isSubmitting ||
                navigating ||
                publishBlockers.length > 0 ||
                applyingResources
              }
              onClick={handleSubmit((values) => onSubmit(values, true))}
            >
              {isSubmitting && publishIntent ? t('publishing') : t('saveAndPublish')}
            </Button>
          </div>
        </div>
      ) : (
        // Create Draft stays enabled on a pristine form: the file-first flow
        // creates an empty draft and moves on to adding resources (ADR-039)
        <Button
          type="submit"
          disabled={
            disabled ||
            isSubmitting ||
            navigating ||
            (mode === 'edit' && !hasChanges) ||
            applyingResources
          }
        >
          {isSubmitting
            ? mode === 'create'
              ? tc('creating')
              : tc('saving')
            : mode === 'create'
              ? t('createDraft')
              : tc('save')}
        </Button>
      )}
    </form>
  )
}
