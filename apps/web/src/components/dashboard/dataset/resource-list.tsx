'use client'

import { Fragment, useState, useRef, useCallback } from 'react'
import {
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
} from '@kukan/ui'
import { Upload, X, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { detectFormat } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { PipelineStatusBadge } from './pipeline-status-badge'
import { FileUploadZone } from './file-upload-zone'
import { ResourceFormFields } from './resource-form-fields'
import type { PipelineStatus } from '@/hooks/use-pipeline-status'

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  format?: string | null
  description?: string | null
  pipelineStatus?: PipelineStatus | null
}

interface FormState {
  name: string
  url: string
  urlType: string | null
  format: string
  description: string
}

const emptyForm: FormState = { name: '', url: '', urlType: null, format: '', description: '' }

interface ResourceListProps {
  packageId: string
  resources: Resource[]
  onUpdated: () => void
}

export function ResourceList({ packageId, resources, onUpdated }: ResourceListProps) {
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

  // --- Helpers ---

  function resetForm() {
    setEditId(null)
    setCreating(false)
    setFormState(emptyForm)
    setFormError(null)
    setReplacing(false)
    setPendingFile(null)
    setUploadingResourceId(null)
    setDragOver(false)
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
    setFormError(null)
    setReplacing(false)
    setPendingFile(null)
    setUploadingResourceId(null)
  }

  function startCreate() {
    setEditId(null)
    setCreating(true)
    setFormState(emptyForm)
    setFormError(null)
    setReplacing(false)
    setPendingFile(null)
    setUploadingResourceId(null)
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

  // --- Save (edit) ---

  async function handleSave() {
    if (!editId) return
    setSaving(true)
    setFormError(null)
    try {
      const body: Record<string, string> = {}
      if (formState.name) body.name = formState.name
      if (formState.urlType === 'upload') {
        body.url_type = 'upload'
      } else if (formState.url) {
        body.url = formState.url
      }
      if (formState.format) body.format = formState.format
      if (formState.description) body.description = formState.description
      const res = await clientFetch(`/api/v1/resources/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setFormError(t('failedToUpdate'))
        return
      }
      if (pendingFile) {
        setUploadingResourceId(editId)
        return
      }
      resetForm()
      onUpdated()
    } catch {
      setFormError(t('failedToUpdate'))
    } finally {
      setSaving(false)
    }
  }

  // --- Create ---

  async function handleCreate() {
    setSaving(true)
    setFormError(null)
    try {
      const body: Record<string, string> = {}
      if (formState.name) body.name = formState.name
      if (formState.description) body.description = formState.description

      if (formState.urlType === 'upload') {
        if (!pendingFile) return
        body.url_type = 'upload'
        body.format = formState.format || detectFormat(pendingFile.name) || ''
      } else {
        if (formState.url) body.url = formState.url
        body.format = formState.format || detectFormat(formState.url) || ''
      }
      if (!body.format) delete body.format

      const res = await clientFetch(`/api/v1/packages/${packageId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setFormError(data.detail || t('failedToAdd'))
        return
      }

      if (formState.urlType === 'upload') {
        const resource = await res.json()
        setUploadingResourceId(resource.id)
      } else {
        resetForm()
        onUpdated()
      }
    } catch {
      setFormError(t('failedToAdd'))
    } finally {
      setSaving(false)
    }
  }

  function handleUploadComplete() {
    resetForm()
    onUpdated()
  }

  // --- Delete ---

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await clientFetch(`/api/v1/resources/${deleteId}`, { method: 'DELETE' })
      if (res.ok) {
        setDeleteId(null)
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
    const isExistingUpload = isEditing && !creating

    return (
      <>
        {formError && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {formError}
          </div>
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
                {isExistingUpload && !replacing && !pendingFile ? (
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
                    className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6 transition-colors ${
                      dragOver || pendingFile
                        ? 'border-primary bg-primary/5'
                        : 'border-muted-foreground/25'
                    }`}
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
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {resources.length === 0 && !creating ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('noResources')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('name')}</TableHead>
              <TableHead>{tc('format')}</TableHead>
              <TableHead>{t('source')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              <TableHead className="w-[120px]">{tc('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resources.map((r) => (
              <Fragment key={r.id}>
                <TableRow>
                  <TableCell>{r.name || '-'}</TableCell>
                  <TableCell>
                    {r.format ? <Badge variant="secondary">{r.format}</Badge> : '-'}
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
                      <PipelineStatusBadge resourceId={r.id} initialStatus={r.pipelineStatus} />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(r)}>
                        {tc('edit')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(r.id)}>
                        {tc('delete')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {activeFormId === r.id && (
                  <TableRow key={`${r.id}-edit`}>
                    <TableCell colSpan={5} className="bg-muted/30 p-4">
                      {renderInlineForm()}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {creating && (
              <TableRow>
                <TableCell colSpan={5} className="bg-muted/30 p-4">
                  {renderInlineForm()}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {!creating && !editId && (
        <Button variant="outline" size="sm" onClick={startCreate}>
          <Plus className="mr-1 size-4" />
          {t('addResource')}
        </Button>
      )}

      <DeleteConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={t('deleteResource')}
        description={t('deleteResourceConfirm')}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </>
  )
}
