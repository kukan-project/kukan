'use client'

import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useLatestJson } from '@/hooks/use-latest-json'
import { useUser } from '@/components/dashboard/user-provider'
import { MaintenanceNotice } from '@/components/dashboard/maintenance-notice'

interface RowGroupStatus {
  /** Previews that never recorded what their row groups hold. */
  unrecordedCount: number
  /** Of those, the ones a smaller group would let the feed serve — reprocessed. */
  reinterpretCount: number
}

/**
 * One-time prompt to record what each preview's row groups hold (ADR-055 §6).
 * Sysadmin-only, and gone once the count reaches zero — every preview written
 * now records the figure as it is interpreted.
 *
 * Its own notice rather than a line under the version backfill: that one is
 * about versions (ADR-043), and a reader deciding whether to press a button is
 * owed a title that names what it does.
 */
export function RowGroupBackfillNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.rowGroupBackfill')
  const { data: status, fetch: reload } = useLatestJson<RowGroupStatus>(
    sysadmin ? '/api/v1/admin/row-group-status' : null
  )

  if (status === null || status.unrecordedCount === 0) return null

  // The second line only where there is reprocessing to warn about: a card that
  // says "0 will be reprocessed" makes the reader stop and work out that it
  // means nothing.
  const lines = [t('description', { count: status.unrecordedCount })]
  if (status.reinterpretCount > 0) {
    lines.push(t('reinterpret', { count: status.reinterpretCount }))
  }

  return (
    <MaintenanceNotice
      title={t('title')}
      lines={lines}
      action={t('record')}
      running={t('recording')}
      queued={t('queued')}
      reload={reload}
      onRun={async () =>
        (await clientFetch('/api/v1/admin/record-row-groups', { method: 'POST' })).ok
      }
    />
  )
}
