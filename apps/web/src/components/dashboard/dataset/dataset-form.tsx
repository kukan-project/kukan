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
  Field,
  FieldControl,
  FieldLabel,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  badgeVariants,
  cn,
} from '@kukan/ui'
import { Sparkles } from 'lucide-react'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { SwitchField } from '@/components/switch-field'
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
  /** Reports the form's own in-flight submission for page-level exclusion */
  onBusyChange?: (busy: boolean) => void
  /** Increment to submit the form from outside (the new page's drop zone) */
  submitSignal?: number
  /** Reports the new draft's id while the page is still mounted */
  onDraftCreated?: (draftId: string) => void
  /** AI metadata suggestions (ADR-040); absent = feature hidden */
  suggest?: {
    /** Site capability (null while loading — button hidden until known) */
    enabled: boolean | null
    /** Local model in use — shows a quality caveat next to the button */
    localModel?: boolean
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
  onBusyChange,
  submitSignal,
  onDraftCreated,
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

  // The new page's drop zone creates its draft by submitting this form, so
  // what the user already typed goes with it. Same counter convention as
  // openSignal above.
  const lastSubmitSignal = useRef(submitSignal)
  useEffect(() => {
    if (submitSignal !== lastSubmitSignal.current) {
      lastSubmitSignal.current = submitSignal
      if (submitSignal) void handleSubmit((values) => onSubmit(values))()
    }
  }, [submitSignal])

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
          const failed = results.filter((r) => !r.ok).length
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

  // A lone organization is not a choice — preselect it. Creation
  // only: on an existing dataset the stored owner wins, blank or not. An effect,
  // not a defaultValue: the options arrive from the page after mount.
  useEffect(() => {
    if (mode === 'create' && organizations.length === 1 && !liveOwnerOrg) {
      setValue('ownerOrg', organizations[0].id)
    }
  }, [mode, organizations, liveOwnerOrg, setValue])

  /** `adopt` marks a save triggered by adopting AI suggestions: it carries the
   *  just-set tags/groups (React state is still stale here) and keeps the user
   *  on the page afterwards */
  const onSubmit = async (
    values: DatasetFormInput,
    publishAfter = false,
    adopt?: { tagsInput?: string; groups?: string[] }
  ) => {
    try {
      await submitValues(values, publishAfter, adopt)
    } catch {
      // A rejected fetch (offline, DNS, dropped connection) never reached the
      // response handling below, so nothing has reported it yet
      setError(tc('failedToCreate'))
    }
  }

  const submitValues = async (
    values: DatasetFormInput,
    publishAfter: boolean,
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
      onDraftCreated?.(created.id)
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
        // The save itself landed, so every publish failure — including a
        // request that never got a response — says so and keeps the draft
        // editable, rather than reading as a failed save
        const savedButNotPublished = (detail: string) => {
          setPublishError(t('savedButPublishFailed', { detail }))
          onSaved?.()
        }
        let pubRes: Response
        try {
          pubRes = await clientFetch(`/api/v1/packages/${nameOrId}/publish`, {
            method: 'POST',
          })
        } catch {
          savedButNotPublished(t('publishFailed'))
          return
        }
        if (!pubRes.ok) {
          const data = await pubRes.json().catch(() => ({}))
          savedButNotPublished(data.detail || t('publishFailed'))
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
          {suggest?.localModel && (
            <span role="note" className="text-xs text-muted-foreground">
              {t('aiSuggestLocalModelNote')}
            </span>
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

      <Field
        id="name"
        description={isDraftMode ? `${tc('nameHelp')} ${t('draftNameHelp')}` : tc('nameHelp')}
        error={errors.name?.message}
      >
        <FieldLabel>{isDraftMode ? tc('urlIdentifier') : tc('nameRequired')}</FieldLabel>
        <FieldControl>
          <Input placeholder="my-dataset" {...register('name')} disabled={!isDraftMode} />
        </FieldControl>
      </Field>

      <Field id="title">
        <FieldLabel>{tc('title')}</FieldLabel>
        <FieldControl>
          <Input placeholder={t('titlePlaceholder')} {...register('title')} />
        </FieldControl>
      </Field>

      <Field id="notes">
        <FieldLabel>{tc('description')}</FieldLabel>
        <FieldControl>
          <Textarea placeholder={t('descriptionPlaceholder')} rows={4} {...register('notes')} />
        </FieldControl>
      </Field>

      <Field id="ownerOrg" error={errors.ownerOrg && tc('required')}>
        <FieldLabel>{isDraftMode ? tc('organization') : t('orgRequired')}</FieldLabel>
        <Controller
          name="ownerOrg"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <FieldControl>
                <SelectTrigger>
                  <SelectValue placeholder={t('orgSelect')} />
                </SelectTrigger>
              </FieldControl>
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
      </Field>

      <Controller
        name="private"
        control={control}
        render={({ field }) => (
          <SwitchField
            id="private"
            label={tc('private')}
            labelClassName="font-medium"
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />

      <Field id="tags" description={t('tagsHelp')}>
        <FieldLabel>{t('tags')}</FieldLabel>
        <FieldControl>
          <Input
            placeholder={t('tagsPlaceholder')}
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </FieldControl>
      </Field>

      {/* A title, not a label: the categories are a set of toggles, so the
          group is named rather than a control pointed at */}
      <Field
        title={t('categories')}
        description={groupOptions.length === 0 ? t('noCategoriesAvailable') : t('categoriesHelp')}
      >
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
                  badgeVariants({ variant: selected ? 'default' : 'outline', wrap: true }),
                  'cursor-pointer'
                )}
              >
                {g.title || g.name}
              </button>
            )
          })}
        </div>
      </Field>

      <Field id="licenseId" error={errors.licenseId && tc('required')}>
        <FieldLabel>{isDraftMode ? tc('license') : t('licenseRequired')}</FieldLabel>
        <Controller
          name="licenseId"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <FieldControl>
                <SelectTrigger>
                  <SelectValue placeholder={t('licenseSelect')} />
                </SelectTrigger>
              </FieldControl>
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
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="author">
          <FieldLabel>{t('author')}</FieldLabel>
          <FieldControl>
            <Input {...register('author')} />
          </FieldControl>
        </Field>
        <Field id="authorEmail" error={errors.authorEmail?.message}>
          <FieldLabel>{t('authorEmail')}</FieldLabel>
          <FieldControl>
            <Input type="email" {...register('authorEmail')} />
          </FieldControl>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="maintainer">
          <FieldLabel>{t('maintainerLabel')}</FieldLabel>
          <FieldControl>
            <Input {...register('maintainer')} />
          </FieldControl>
        </Field>
        <Field id="maintainerEmail" error={errors.maintainerEmail?.message}>
          <FieldLabel>{t('maintainerEmail')}</FieldLabel>
          <FieldControl>
            <Input type="email" {...register('maintainerEmail')} />
          </FieldControl>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="url" error={errors.url?.message}>
          <FieldLabel>URL</FieldLabel>
          <FieldControl>
            <Input type="url" placeholder="https://example.com" {...register('url')} />
          </FieldControl>
        </Field>
        <Field id="version">
          <FieldLabel>{t('version')}</FieldLabel>
          <FieldControl>
            <Input placeholder="1.0" {...register('version')} />
          </FieldControl>
        </Field>
      </div>

      <Field title={t('extras')} description={t('extrasHelp')} error={extrasError}>
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
      </Field>

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
              disabled={isSubmitting || navigating || !hasChanges || applyingResources}
            >
              {isSubmitting && !publishIntent ? tc('saving') : t('saveDraft')}
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={
                isSubmitting || navigating || publishBlockers.length > 0 || applyingResources
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
            isSubmitting || navigating || (mode === 'edit' && !hasChanges) || applyingResources
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
