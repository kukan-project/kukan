'use client'

import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_MB } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { stashPendingDropFiles } from '@/lib/pending-drop-files'
import { hasRole } from '@/hooks/use-my-roles'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dashboard/dataset/dataset-form'
import { DropFilesZone } from '@/components/dashboard/dataset/drop-files-zone'

interface Organization {
  id: string
  name: string
  title?: string
  role?: string
}

export default function NewDatasetPage() {
  const t = useTranslations('dataset')
  const tr = useTranslations('resource')
  const tc = useTranslations('common')
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [formBusy, setFormBusy] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  // Incremented to submit the form; the form is the only thing that creates a draft
  const [submitSignal, setSubmitSignal] = useState(0)
  // Dropped files wait here for the draft they belong to
  const pendingFiles = useRef<File[] | null>(null)

  // Creating needs editor in the owning organization
  useEffect(() => {
    clientFetch('/api/v1/users/me/organizations').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setOrganizations(data.items.filter((o: Organization) => hasRole(o.role, 'editor')))
      }
    })
  }, [])

  // File-first creation (ADR-039): dropping files creates the draft, then the
  // edit page picks the files up from the stash and uploads them as resources.
  // The draft comes from submitting the form rather than a POST of this page's
  // own, which navigated away from whatever had already been typed
  function handleDropFiles(files: File[]) {
    const oversized = files.filter((f) => f.size > MAX_UPLOAD_SIZE)
    if (oversized.length > 0) {
      // Reject the whole drop: navigation follows immediately, so a partial
      // accept would leave the per-file errors with no page to show them on
      setDropError(
        `${oversized.map((f) => f.name).join(', ')}: ${tr('fileTooLarge', { size: MAX_UPLOAD_SIZE_MB })}`
      )
      return
    }
    setDropError(null)
    // Held until the form reports an id: there is nothing to stash them under
    // before the draft exists, and a failed create leaves them for the retry
    pendingFiles.current = files
    setSubmitSignal((n) => n + 1)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createDataset')} />
      <DropFilesZone
        hint={formBusy ? tc('creating') : t('dropZoneHint')}
        disabled={formBusy}
        onFiles={handleDropFiles}
      />
      {dropError && (
        <Alert variant="destructive">
          <AlertDescription>{dropError}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DatasetForm
            mode="create"
            organizations={organizations}
            onBusyChange={setFormBusy}
            submitSignal={submitSignal}
            onDraftCreated={(draftId) => {
              // Only a drop leaves files behind; an ordinary submit stashes nothing
              if (pendingFiles.current) stashPendingDropFiles(draftId, pendingFiles.current)
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
