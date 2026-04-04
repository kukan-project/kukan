'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
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
  const t = useTranslations('dashboard.adminReset')

  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

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

      <div className="flex items-start gap-3 rounded-md border border-destructive bg-destructive/10 p-4">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <p className="text-sm text-destructive">{t('warning')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('confirmLabel')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('resultTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              <li>{t('resultPackages', { count: result.deleted.packages })}</li>
              <li>{t('resultOrganizations', { count: result.deleted.organizations })}</li>
              <li>{t('resultGroups', { count: result.deleted.groups })}</li>
              <li>{t('resultTags', { count: result.deleted.tags })}</li>
              <li>{t('resultStorage', { count: result.deleted.storageObjects })}</li>
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
