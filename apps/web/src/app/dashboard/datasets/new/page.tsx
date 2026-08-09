'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_MB } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { stashPendingResources } from '@/lib/pending-resources'
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
  // Not validated here: what a resource url may be is the server's rule
  // (scheme, SSRF), and a second copy of it would only be the one that is wrong
  const [sourceUrl, setSourceUrl] = useState('')

  // Creating needs editor in the owning organization (kukan#260)
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
  // own, which navigated away from whatever had already been typed (kukan#243)
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
      {/* Data that sits elsewhere, which until now meant creating the dataset
          empty and then editing it (kukan#295). Submitted with the form rather
          than at once like a drop: a url is typed, a keystroke at a time. */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="source-url">{tr('sourceUrl')}</Label>
        <Input
          id="source-url"
          type="url"
          inputMode="url"
          placeholder="https://example.com/data.csv"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          disabled={formBusy}
        />
        <p className="text-sm text-muted-foreground">{t('resourceUrlHint')}</p>
      </div>
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
              const files = pendingFiles.current ?? []
              const url = sourceUrl.trim() || null
              // Neither leaves the draft empty, as an ordinary submit always did
              if (files.length > 0 || url) stashPendingResources(draftId, { files, url })
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
