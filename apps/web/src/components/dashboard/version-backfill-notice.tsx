'use client'

import { useEffect, useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useUser } from '@/components/dashboard/user-provider'

/**
 * One-time version-backfill prompt (ADR-043). Sysadmin-only. Shows only while
 * resources are still missing a version, and disappears once the migration
 * completes — so it never lingers as permanent clutter.
 */
export function VersionBackfillNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.versionBackfill')
  const [count, setCount] = useState<number | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    if (!sysadmin) return
    clientFetch('/api/v1/admin/version-backfill-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setCount(data.unversionedCount)
      })
      .catch(() => {})
  }, [sysadmin])

  async function handleBackfill() {
    setBackfilling(true)
    const res = await clientFetch('/api/v1/admin/backfill-versions', { method: 'POST' })
    setBackfilling(false)
    if (res.ok) setQueued(true)
  }

  if (!sysadmin || count === null || count === 0) return null

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-base">{t('backfillTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('backfillDescription', { count })}</p>
        <div className="flex items-center gap-4">
          <Button onClick={handleBackfill} disabled={backfilling || queued}>
            {backfilling ? t('backfilling') : t('backfill')}
          </Button>
          {queued && <p className="text-sm text-muted-foreground">{t('backfillQueued')}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
