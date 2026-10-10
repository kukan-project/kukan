'use client'

import { useTranslations } from 'next-intl'
import { requestReindex } from '@/lib/request-reindex'
import { useLatestJson } from '@/hooks/use-latest-json'
import { useUser } from '@/components/dashboard/user-provider'
import { MaintenanceNotice } from '@/components/dashboard/maintenance/maintenance-notice'

/**
 * Prompt to index again the content cut under a larger chunk size than the one
 * in force. A chunk's size is fixed when it is written, and nothing rewrites a
 * resource whose bytes have not changed, so an upgrade that lowers it reaches
 * the catalogue only from here.
 *
 * Sysadmin-only. The count is of resources still holding a larger chunk, so it
 * falls as the runs finish, and the card goes with the last of them.
 */
export function ContentChunkNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.contentChunks')
  const { data, fetch: reload } = useLatestJson<{ resources: number }>(
    sysadmin ? '/api/v1/admin/search/chunk-status' : null
  )

  const count = data?.resources
  if (!count) return null

  return (
    <MaintenanceNotice
      title={t('title')}
      lines={[t('description', { count })]}
      action={t('rebuild')}
      running={t('rebuilding')}
      queued={t('queued')}
      reload={reload}
      // The rebuild the search admin page queues with its content switch on
      onRun={async () => (await requestReindex({ reindexContent: true })).ok}
    />
  )
}
