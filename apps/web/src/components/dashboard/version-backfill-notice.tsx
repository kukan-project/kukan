'use client'

import { useEffect, useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useUser } from '@/components/dashboard/user-provider'

interface BackfillStatus {
  /** Layer 1: resources with no version at all. */
  unversionedCount: number
  /** Layer 2: tabular current versions not yet loaded into DuckLake. */
  pendingLakeIngestCount: number
  /** Resources still holding versions an old-style revert set aside (ADR-044 §4). */
  unconvertedRevertCount: number
}

/**
 * One-time version-backfill prompt (ADR-043). Sysadmin-only. Shows only while
 * migration work remains — versions to create, current versions to load into
 * DuckLake for row-level diff, or old-style reverts to convert — and disappears
 * once all are done, so it never lingers as permanent clutter.
 */
export function VersionBackfillNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.versionBackfill')
  const [status, setStatus] = useState<BackfillStatus | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    if (!sysadmin) return
    clientFetch('/api/v1/admin/version-backfill-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStatus(data)
      })
      .catch(() => {})
  }, [sysadmin])

  async function handleBackfill() {
    setBackfilling(true)
    const res = await clientFetch('/api/v1/admin/backfill-versions', { method: 'POST' })
    setBackfilling(false)
    if (res.ok) setQueued(true)
  }

  if (!sysadmin || status === null) return null
  // One line per migration with work left. As a list rather than a conjunction
  // plus a block each: the next migration is then one entry, not three edits in
  // two places.
  const outstanding = (
    [
      ['backfillDescription', status.unversionedCount],
      ['lakeIngestDescription', status.pendingLakeIngestCount],
      ['convertRevertsDescription', status.unconvertedRevertCount],
    ] as const
  ).filter(([, count]) => count > 0)
  if (outstanding.length === 0) return null

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-base">{t('backfillTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          {outstanding.map(([key, count]) => (
            <p key={key}>{t(key, { count })}</p>
          ))}
        </div>
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
