'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@kukan/ui'
import { normalizeFormat } from '@kukan/shared'
import { updateResource } from '@/lib/update-resource'
import { useProblemMessage } from '@/hooks/use-problem-message'
import { ResourceFormFields } from './resource-form-fields'
import { ExtrasFields, snapshotExtras, useExtrasRows } from './extras-fields'
import { FileUploadZone } from './file-upload-zone'
import { ResourceSourceTabs } from './resource-source-tabs'

export interface EditableResource {
  id: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  format?: string | null
  description?: string | null
  extras?: Record<string, unknown> | null
}

interface FormState {
  name: string
  url: string
  urlType: string | null
  format: string
  description: string
}

function toForm(r: EditableResource): FormState {
  return {
    name: r.name ?? '',
    url: r.url ?? '',
    urlType: r.urlType ?? null,
    format: r.format ?? '',
    description: r.description ?? '',
  }
}

/**
 * A resource's own fields, on its Basic tab (ADR-072 decision 4). Saving does
 * not make a version unless the source or format moved, and only those queue a
 * run (decision 6) — the API decides by `updateRunsPipeline`.
 *
 * Moved here from the dataset page's resource table, where it opened inside
 * the row.
 */
export function ResourceEditForm({
  resource,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  resource: EditableResource
  /** After a save or a finished upload — the page reads the resource back */
  onSaved: () => void
  /** Whether the form holds changes not yet saved (ADR-072 decision 5's guard) */
  onDirtyChange?: (dirty: boolean) => void
  /** Whether a save or an upload is under way, for the page's delete to wait on */
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const describeProblem = useProblemMessage()
  const [formState, setFormState] = useState<FormState>(() => toForm(resource))
  const extrasEditor = useExtrasRows(resource.extras)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  // Said once a save lands, until the next change: the button only disables,
  // which reads the same as a save that has not happened
  const [justSaved, setJustSaved] = useState(false)

  // A save reads the resource back; take what the server now holds as the form.
  // Keyed on the content, not the copy: a run settling reads the same resource
  // again, and taking that copy would throw away whatever is being typed.
  const storedForm = useMemo(() => JSON.stringify(toForm(resource)), [resource])
  const storedExtras = useMemo(
    () => JSON.stringify(Object.entries(resource.extras ?? {})),
    [resource]
  )
  const stored = storedForm + storedExtras
  useEffect(() => {
    setFormState(toForm(resource))
    extrasEditor.reset(resource.extras)
    setPendingFile(null)
  }, [stored])

  const dirty =
    !!pendingFile ||
    JSON.stringify(formState) !== storedForm ||
    snapshotExtras(extrasEditor.rows) !== storedExtras
  useEffect(() => {
    onDirtyChange?.(dirty)
    if (dirty) setJustSaved(false)
  }, [dirty, onDirtyChange])
  const busy = saving || uploading
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  const isUploadTab = formState.urlType === 'upload'
  // A link turned into an upload has nothing to serve until a file comes:
  // saved without one, it would be an upload named after its old URL
  const needsFile = isUploadTab && resource.urlType !== 'upload' && !pendingFile

  // What a save does to the versions, said before it is made (ADR-072
  // decision 6). The format is an input to version identity, so changing it
  // always makes one; a new source makes one only if the contents differ, which
  // is not known until they are read.
  const formatMoved =
    normalizeFormat(formState.format || '') !== normalizeFormat(resource.format || '')
  const sourceMoved =
    !!pendingFile ||
    (formState.urlType ?? null) !== (resource.urlType ?? null) ||
    (formState.urlType !== 'upload' && (formState.url || '') !== (resource.url || ''))
  const versionNote = formatMoved
    ? t('saveMakesVersion')
    : sourceMoved
      ? t('saveMayMakeVersion')
      : null
  const [confirmingVersion, setConfirmingVersion] = useState(false)

  async function handleSave() {
    const extras = extrasEditor.build()
    if (!extras) return
    setSaving(true)
    setFormError(null)
    // A file still to come carries the source and format with it, and its
    // promotion applies them together with the bytes. Written here, they would
    // switch the live resource before the file exists: the download would stop
    // pointing at the link, and an abandoned upload would leave it that way.
    // Otherwise the form's tab says the type (null is a link); on the upload
    // tab the existing url is kept by leaving it out.
    const source: Record<string, unknown> = pendingFile
      ? {}
      : {
          urlType: formState.urlType,
          format: formState.format || undefined,
          ...(formState.urlType !== 'upload' && { url: formState.url || undefined }),
        }
    try {
      const updated = await updateResource(resource.id, {
        name: formState.name || undefined,
        ...source,
        description: formState.description || undefined,
        // Always sent: the PUT replaces extras whole, and the form holds all of them
        extras,
      })
      if (!updated.ok) {
        setFormError(describeProblem(updated.problem) ?? t('failedToUpdate'))
        return
      }
      if (pendingFile) {
        setUploading(true)
        return
      }
      setJustSaved(true)
      onSaved()
    } catch {
      setFormError(t('failedToUpdate'))
    } finally {
      setSaving(false)
    }
  }

  if (uploading) {
    return (
      <div className="flex flex-col gap-2">
        <FileUploadZone
          resourceId={resource.id}
          initialFile={pendingFile ?? undefined}
          format={formState.format || undefined}
          onComplete={() => {
            setUploading(false)
            setPendingFile(null)
            onSaved()
          }}
        />
        {/* A cancelled or failed upload leaves the resource as it was; the
            fields saved before it are already stored */}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUploading(false)
              setPendingFile(null)
              onSaved()
            }}
          >
            {t('backToFields')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t('basicSaveNote')}</p>
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <ResourceFormFields
        idPrefix="edit"
        name={formState.name}
        onNameChange={(v) => setFormState((s) => ({ ...s, name: v }))}
        format={formState.format}
        onFormatChange={(v) => setFormState((s) => ({ ...s, format: v }))}
        description={formState.description}
        onDescriptionChange={(v) => setFormState((s) => ({ ...s, description: v }))}
      >
        <ResourceSourceTabs
          // A save takes the stored copy as the form; a replacement under way goes with it
          key={stored}
          idPrefix="edit"
          urlType={formState.urlType}
          url={formState.url}
          file={pendingFile}
          existingUpload={resource.urlType === 'upload' ? resource.url || t('sourceUpload') : null}
          onTypeChange={(urlType) => setFormState((s) => ({ ...s, urlType }))}
          onUrlChange={(url) => setFormState((s) => ({ ...s, url }))}
          onFileChange={setPendingFile}
          onFormatDetected={(format) => setFormState((s) => ({ ...s, format }))}
        />
      </ResourceFormFields>
      <ExtrasFields editor={extrasEditor} />
      {needsFile && <p className="text-xs text-muted-foreground">{t('chooseFileToSwitch')}</p>}
      <div className="flex gap-2">
        <Button
          onClick={() => (versionNote ? setConfirmingVersion(true) : handleSave())}
          disabled={saving || !dirty || needsFile}
        >
          {saving ? tc('updating') : tc('save')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setFormState(toForm(resource))
            extrasEditor.reset(resource.extras)
            setPendingFile(null)
            setFormError(null)
          }}
          disabled={saving || !dirty}
        >
          {tc('cancel')}
        </Button>
        {justSaved && (
          <span role="status" className="self-center text-sm text-muted-foreground">
            {tc('saved')}
          </span>
        )}
      </div>
      <Dialog open={confirmingVersion} onOpenChange={setConfirmingVersion}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('saveVersionTitle')}</DialogTitle>
            <DialogDescription>{versionNote}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingVersion(false)}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirmingVersion(false)
                void handleSave()
              }}
            >
              {tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
