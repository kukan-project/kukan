'use client'

import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useFetch } from '@/hooks/use-fetch'
import { useUser } from '@/components/dashboard/user-provider'
import { MaintenanceNotice } from '@/components/dashboard/maintenance-notice'

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
  const { data: status } = useFetch<BackfillStatus>(
    sysadmin ? '/api/v1/admin/version-backfill-status' : null
  )

  if (status === null) return null
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
    <MaintenanceNotice
      title={t('backfillTitle')}
      lines={outstanding.map(([key, count]) => t(key, { count }))}
      action={t('backfill')}
      running={t('backfilling')}
      queued={t('backfillQueued')}
      onRun={async () =>
        (await clientFetch('/api/v1/admin/backfill-versions', { method: 'POST' })).ok
      }
    />
  )
}
