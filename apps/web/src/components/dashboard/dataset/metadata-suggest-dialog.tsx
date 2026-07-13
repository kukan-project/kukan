'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import type { SuggestMetadataResponse } from '@kukan/shared'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  Textarea,
} from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { parseTags } from '@/lib/parse-tags'
import { FormatBadge } from '@/components/format-badge'

export interface SuggestResourceInfo {
  id: string
  name?: string | null
  description?: string | null
  format?: string | null
  pipelineStatus?: string | null
}

export interface SuggestSelection {
  title?: string
  notes?: string
  tags?: string[]
  /** Per-resource updates; only the fields the user opted into are present */
  resources?: { id: string; name?: string; description?: string }[]
}

interface MetadataSuggestDialogProps {
  nameOrId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  current: {
    title: string
    notes: string
    tags: string[]
    resources: SuggestResourceInfo[]
  }
  /** Receives only the fields the user opted into; the caller persists them */
  onApply: (selection: SuggestSelection) => void
}

/** One selectable current/proposed row. `bordered` is false when several rows
 *  share one frame (a resource's name + description). When adopted and
 *  `onProposedChange` is given, the proposed value becomes editable. */
function SuggestRow({
  label,
  current,
  proposed,
  edited,
  checked,
  onCheckedChange,
  onProposedChange,
  multiline,
  proposedExtra,
  bordered = true,
}: {
  label: string
  current: string
  /** Original LLM value — the no-op check compares against this */
  proposed: string
  /** User's edit override, if any; shown/edited in place of `proposed` */
  edited?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** When provided, the proposed value is editable once adopted */
  onProposedChange?: (value: string) => void
  multiline?: boolean
  proposedExtra?: React.ReactNode
  bordered?: boolean
}) {
  const t = useTranslations('dataset')
  // The AI reviewed this field but proposed nothing new — adopting is a no-op
  const unchanged = current === proposed
  const editable = checked && !unchanged && !!onProposedChange
  const display = edited ?? proposed
  return (
    <div className={`flex flex-col gap-2${bordered ? ' rounded-md border p-3' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {unchanged ? t('aiSuggestNoChange') : t('aiSuggestAdopt')}
          <Switch
            checked={checked && !unchanged}
            onCheckedChange={onCheckedChange}
            disabled={unchanged}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-muted/50 p-2 text-sm">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('aiSuggestCurrent')}
          </p>
          <p className="whitespace-pre-wrap break-words">
            {current || <span className="text-muted-foreground">{t('aiSuggestEmpty')}</span>}
          </p>
        </div>
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-sm">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('aiSuggestProposed')}
          </p>
          {editable ? (
            multiline ? (
              <Textarea
                value={display}
                onChange={(e) => onProposedChange!(e.target.value)}
                className="min-h-20 bg-background text-sm"
              />
            ) : (
              <Input
                value={display}
                onChange={(e) => onProposedChange!(e.target.value)}
                className="bg-background text-sm"
              />
            )
          ) : (
            <p className="whitespace-pre-wrap break-words">{display}</p>
          )}
          {proposedExtra}
        </div>
      </div>
    </div>
  )
}

export function MetadataSuggestDialog({
  nameOrId,
  open,
  onOpenChange,
  current,
  onApply,
}: MetadataSuggestDialogProps) {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const locale = useLocale()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SuggestMetadataResponse | null>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  // User edits to proposed values, keyed like `selected`; absent = use the LLM value
  const [edits, setEdits] = useState<Record<string, string>>({})
  // One generation per dialog opening — the LLM call is the expensive part
  const requestedFor = useRef(false)

  useEffect(() => {
    if (!open) {
      requestedFor.current = false
      return
    }
    if (requestedFor.current) return
    requestedFor.current = true
    setLoading(true)
    setError(null)
    setResult(null)
    setEdits({})
    ;(async () => {
      try {
        const res = await clientFetch(`/api/v1/packages/${nameOrId}/suggest-metadata`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(
            res.status === 429
              ? t('aiSuggestRateLimited')
              : res.status === 503
                ? t('aiSuggestUnavailable')
                : body.detail || t('aiSuggestFailed')
          )
          return
        }
        const data: SuggestMetadataResponse = await res.json()
        setResult(data)
        // Every field starts unadopted; the user opts into each one explicitly
        setSelected({})
      } catch {
        setError(t('aiSuggestFailed'))
      } finally {
        setLoading(false)
      }
    })()
    // Regenerate only when the dialog (re)opens, not when inputs drift
  }, [open])

  // Adopted value for a field: the user's edit if present, else the LLM value
  const valueOf = (key: string, llm: string) => (key in edits ? edits[key] : llm)
  // Tags are presented/edited as one comma-separated string (matching the form)
  const tagsJoined = result ? result.suggestion.tags.map((tag) => tag.name).join(', ') : ''

  function handleApply() {
    if (!result) return
    const selection: SuggestSelection = {}
    if (selected.title) selection.title = valueOf('title', result.suggestion.title)
    if (selected.notes) selection.notes = valueOf('notes', result.suggestion.notes)
    if (selected.tags) selection.tags = parseTags(valueOf('tags', tagsJoined))
    const resources = result.suggestion.resources
      .map((r) => ({
        id: r.id,
        ...(selected[`resname:${r.id}`] && { name: valueOf(`resname:${r.id}`, r.name) }),
        ...(selected[`resdesc:${r.id}`] && {
          description: valueOf(`resdesc:${r.id}`, r.description),
        }),
      }))
      .filter((r) => 'name' in r || 'description' in r)
    if (resources.length > 0) selection.resources = resources
    onApply(selection)
    onOpenChange(false)
  }

  const setEdit = (key: string, value: string) => setEdits((s) => ({ ...s, [key]: value }))
  const anySelected = Object.values(selected).some(Boolean)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Block outside-click dismissal so an in-progress review isn't lost by a
          stray click; Esc, the close button, and Cancel still dismiss. */}
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('aiSuggestDialogTitle')}</DialogTitle>
          <DialogDescription>{t('aiSuggestDialogDescription')}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            {t('aiSuggestLoading')}
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {result && (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('aiSuggestDatasetSection')}
              </h3>
              <SuggestRow
                label={tc('title')}
                current={current.title}
                proposed={result.suggestion.title}
                edited={edits.title}
                checked={!!selected.title}
                onCheckedChange={(checked) => setSelected((s) => ({ ...s, title: checked }))}
                onProposedChange={(v) => setEdit('title', v)}
              />
              <SuggestRow
                label={tc('description')}
                current={current.notes}
                proposed={result.suggestion.notes}
                edited={edits.notes}
                checked={!!selected.notes}
                onCheckedChange={(checked) => setSelected((s) => ({ ...s, notes: checked }))}
                onProposedChange={(v) => setEdit('notes', v)}
                multiline
              />
              {result.suggestion.tags.length > 0 && (
                <SuggestRow
                  label={t('tags')}
                  current={current.tags.join(', ')}
                  proposed={tagsJoined}
                  edited={edits.tags}
                  checked={!!selected.tags}
                  onCheckedChange={(checked) => setSelected((s) => ({ ...s, tags: checked }))}
                  onProposedChange={(v) => setEdit('tags', v)}
                  proposedExtra={
                    result.suggestion.tags.some((tag) => tag.isNew) ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {result.suggestion.tags
                          .filter((tag) => tag.isNew)
                          .map((tag) => (
                            <Badge key={tag.name} variant="outline" className="text-[10px]">
                              {t('aiSuggestNewTag', { name: tag.name })}
                            </Badge>
                          ))}
                      </div>
                    ) : undefined
                  }
                />
              )}
            </section>

            {result.suggestion.resources.length > 0 && (
              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('aiSuggestResourceSection')}
                </h3>
                {result.suggestion.resources.map((r) => {
                  const existing = current.resources.find((cr) => cr.id === r.id)
                  const fields = [
                    {
                      key: `resname:${r.id}`,
                      sub: tc('name'),
                      current: existing?.name,
                      proposed: r.name,
                      multiline: false,
                    },
                    {
                      key: `resdesc:${r.id}`,
                      sub: tc('description'),
                      current: existing?.description,
                      proposed: r.description,
                      multiline: true,
                    },
                  ]
                  // One frame per resource holds its name and description rows
                  return (
                    <div key={r.id} className="flex flex-col gap-3 rounded-md border p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{existing?.name || r.id}</span>
                        {existing?.format && <FormatBadge format={existing.format} />}
                      </div>
                      {fields.map((f) => (
                        <SuggestRow
                          key={f.key}
                          bordered={false}
                          label={f.sub}
                          current={f.current ?? ''}
                          proposed={f.proposed}
                          edited={edits[f.key]}
                          checked={!!selected[f.key]}
                          onCheckedChange={(checked) =>
                            setSelected((s) => ({ ...s, [f.key]: checked }))
                          }
                          onProposedChange={(v) => setEdit(f.key, v)}
                          multiline={f.multiline}
                        />
                      ))}
                    </div>
                  )
                })}
                {result.skippedResources.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('aiSuggestSkippedNote', { count: result.skippedResources.length })}
                  </p>
                )}
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleApply} disabled={!result || !anySelected}>
            {t('aiSuggestApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
