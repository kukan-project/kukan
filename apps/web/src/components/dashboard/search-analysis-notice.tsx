'use client'

import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useFetch } from '@/hooks/use-fetch'
import { useUser } from '@/components/dashboard/user-provider'
import { MaintenanceNotice } from '@/components/dashboard/maintenance-notice'

/**
 * One-time prompt to rebuild the search index under the analysis the code now
 * defines (ADR-025). Sysadmin-only, and shown only while the live index was
 * created under different settings — an analyzer is fixed when an index is
 * created, so an upgrade that changes it reaches a running deployment no other
 * way.
 */
export function SearchAnalysisNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.searchAnalysis')
  const { data } = useFetch<{ stale: boolean }>(
    sysadmin ? '/api/v1/admin/search/analysis-status' : null
  )

  if (data?.stale !== true) return null

  return (
    <MaintenanceNotice
      title={t('title')}
      lines={[t('description')]}
      action={t('reanalyse')}
      running={t('reanalysing')}
      queued={t('queued')}
      onRun={async () =>
        (await clientFetch('/api/v1/admin/search/reanalyse', { method: 'POST' })).ok
      }
    />
  )
}
