'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { useLatestJson } from '@/hooks/use-latest-json'
import { useUser } from '@/components/dashboard/user-provider'
import { MaintenanceNotice } from '@/components/dashboard/maintenance-notice'

/**
 * Prompt to rebuild the embeddings semantic search reads (ADR-054).
 *
 * Its own notice rather than a line on the search admin page, because the
 * failure it covers is silent: the release that moved the vector from the
 * package to the resource dropped the old columns, so a catalogue comes up
 * with nothing to match against and every search quietly answers by keyword
 * alone. There is no error to notice and no result missing that a reader could
 * name — which is exactly the case a prompt is for.
 *
 * Sysadmin-only, and shown only while resources are actually unreachable; the
 * count excludes packages with an embed claim outstanding, so an edit waiting
 * on its debounced job does not raise it. Once regeneration is queued it
 * follows `outstanding` instead: regenerating marks every resource it queues,
 * and the count that leaves marked ones out would read zero at once.
 */
export function EmbeddingBackfillNotice() {
  const { sysadmin } = useUser()
  const t = useTranslations('dashboard.embeddingBackfill')
  const { data, fetch: reload } = useLatestJson<{ missing: number; outstanding: number }>(
    sysadmin ? '/api/v1/admin/embedding-status' : null
  )
  const [queued, setQueued] = useState(false)

  const count = queued ? data?.outstanding : data?.missing
  if (!count) return null

  return (
    <MaintenanceNotice
      title={t('title')}
      lines={[t('description', { count })]}
      action={t('regenerate')}
      running={t('regenerating')}
      queued={t('queued')}
      reload={reload}
      onRun={async () => {
        const { ok } = await clientFetch('/api/v1/admin/reindex-embeddings', { method: 'POST' })
        setQueued(ok)
        return ok
      }}
    />
  )
}
