'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Loader2, Search, Trash2 } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
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

export default function AdminResetPage() {
  const user = useUser()
  const router = useRouter()
  const t = useTranslations('dashboard.adminSite')

  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

  // Reindex
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState<{ indexed: number; resourcesIndexed: number } | null>(null)

  async function handleReindex() {
    setReindexing(true)
    setReindexResult(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex', { method: 'POST' })
      if (res.ok) setReindexResult(await res.json())
    } finally {
      setReindexing(false)
    }
  }

  // Reset
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

  if (!user.sysadmin) return null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* Search Index */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('reindexTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('reindexDescription')}</p>
          <div className="flex items-center gap-4">
            <Button onClick={handleReindex} disabled={reindexing}>
              <Search className="mr-2 h-4 w-4" />
              {reindexing ? t('reindexing') : t('reindex')}
            </Button>
            {reindexResult !== null && (
              <p className="text-sm text-muted-foreground">
                {t('reindexResult', {
                  count: reindexResult.indexed,
                  resourceCount: reindexResult.resourcesIndexed,
                })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Data Reset */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('resetTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-md border border-destructive bg-destructive/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{t('warning')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-input">{t('confirmLabel')}</Label>
            <Input
              id="confirm-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={t('confirmPlaceholder')}
              disabled={executing}
              className="max-w-xs font-mono"
            />
          </div>
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
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
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
