'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, AlertDescription, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_MB } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { draftEditPath } from '@/lib/paths'
import { stashPendingDropFiles } from '@/lib/pending-drop-files'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dashboard/dataset/dataset-form'
import { DropFilesZone } from '@/components/dashboard/dataset/drop-files-zone'

interface Organization {
  id: string
  name: string
  title?: string
}

export default function NewDatasetPage() {
  const t = useTranslations('dataset')
  const tr = useTranslations('resource')
  const tc = useTranslations('common')
  const router = useRouter()
  const [organizations, setOrganizations] = useState<Organization[]>([])
  // Draft creation is exclusive page-wide: the drop zone and the form must
  // not run concurrently, or two drafts get created and race the navigation
  const [dropCreating, setDropCreating] = useState(false)
  const [formBusy, setFormBusy] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  useEffect(() => {
    clientFetch('/api/v1/users/me/organizations').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setOrganizations(data.items)
      }
    })
  }, [])

  // File-first creation (ADR-039): dropping files creates the draft, then the
  // edit page picks the files up from the stash and uploads them as resources
  async function handleDropFiles(files: File[]) {
    const oversized = files.filter((f) => f.size > MAX_UPLOAD_SIZE)
    if (oversized.length > 0) {
      // Reject the whole drop: navigation follows immediately, so a partial
      // accept would leave the per-file errors with no page to show them on
      setDropError(
        `${oversized.map((f) => f.name).join(', ')}: ${tr('fileTooLarge', { size: MAX_UPLOAD_SIZE_MB })}`
      )
      return
    }
    setDropCreating(true)
    setDropError(null)
    try {
      const res = await clientFetch('/api/v1/packages/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setDropError(data.detail || t('dropCreateFailed'))
        setDropCreating(false)
        return
      }
      const draft = await res.json()
      stashPendingDropFiles(draft.id, files)
      // Stay disabled until unmount: router.push cannot be awaited, and a
      // second drop or form submit mid-navigation would create another draft
      router.push(draftEditPath(draft.id))
    } catch {
      setDropError(t('dropCreateFailed'))
      setDropCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createDataset')} />
      <DropFilesZone
        hint={dropCreating ? tc('creating') : t('dropZoneHint')}
        disabled={dropCreating || formBusy}
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
            disabled={dropCreating}
            onBusyChange={setFormBusy}
          />
        </CardContent>
      </Card>
    </div>
  )
}
