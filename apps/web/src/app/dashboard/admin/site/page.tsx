'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldControl,
  FieldLabel,
  Input,
} from '@kukan/ui'
import { AiSuggestCard } from '@/components/dashboard/ai-suggest-card'
import { PageHeader } from '@/components/dashboard/page-header'
import { RegistrationCard } from '@/components/dashboard/registration-card'
import { SearchExamplesCard } from '@/components/dashboard/search-examples-card'
import { VectorSimilarityCard } from '@/components/dashboard/vector-similarity-card'
import { clientFetch } from '@/lib/client-api'

interface ResetResult {
  deleted: {
    packages: number
    organizations: number
    groups: number
    tags: number
    storageObjects: number
  }
}

export default function AdminSitePage() {
  const t = useTranslations('dashboard.adminSite')

  const [confirmText, setConfirmText] = useState('')
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<ResetResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const confirmed = confirmText === 'RESET'

  async function handleReset() {
    setExecuting(true)
    setError(null)
    try {
      const res = await clientFetch('/api/v1/admin/data', { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.text()
        setError(`${res.status}: ${body}`)
        return
      }
      setResult(await res.json())
      setConfirmText('')
    } catch (err) {
      setError(String(err))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* Example Query Chips */}
      <SearchExamplesCard />

      {/* Vector Search Settings */}
      <VectorSimilarityCard />

      {/* AI Metadata Suggestions */}
      <AiSuggestCard />

      {/* Self-Registration */}
      <RegistrationCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('resetTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{t('warning')}</AlertDescription>
          </Alert>
          <Field id="confirm-input">
            <FieldLabel>{t('confirmLabel')}</FieldLabel>
            <FieldControl>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={t('confirmPlaceholder')}
                disabled={executing}
                className="max-w-xs font-mono"
              />
            </FieldControl>
          </Field>
          <Button
            variant="destructive"
            onClick={handleReset}
            disabled={!confirmed || executing}
            className="w-fit"
          >
            {executing ? (
              <>
                <Loader2 className="mr-1 size-4 animate-spin" />
                {t('executing')}
              </>
            ) : (
              <>
                <Trash2 className="mr-1 size-4" />
                {t('execute')}
              </>
            )}
          </Button>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {result && (
            <div className="rounded-md border p-3">
              <p className="mb-2 text-sm font-medium">{t('resultTitle')}</p>
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                <li>{t('resultPackages', { count: result.deleted.packages })}</li>
                <li>{t('resultOrganizations', { count: result.deleted.organizations })}</li>
                <li>{t('resultGroups', { count: result.deleted.groups })}</li>
                <li>{t('resultTags', { count: result.deleted.tags })}</li>
                <li>{t('resultStorage', { count: result.deleted.storageObjects })}</li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
