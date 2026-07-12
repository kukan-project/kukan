'use client'

import { useState } from 'react'
import { Button } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

interface PublishSyncBannerProps {
  nameOrId: string
  /** A successful re-publish means the search index is in sync again */
  onPublished: () => void
}

/**
 * Recovery banner for a publish whose search sync may have failed (ADR-039):
 * offers the idempotent re-publish to sync the index. Publishing itself lives
 * in the dataset form ("Save & Publish").
 */
export function PublishSyncBanner({ nameOrId, onPublished }: PublishSyncBannerProps) {
  const t = useTranslations('dataset')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleResync() {
    setPublishing(true)
    setError(null)
    try {
      const res = await clientFetch(`/api/v1/packages/${nameOrId}/publish`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || t('publishFailed'))
        return
      }
      onPublished()
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="rounded-md border border-amber-300/50 bg-amber-500/10 p-3 text-sm dark:border-amber-500/30">
      <p>{t('publishSyncWarning')}</p>
      {error && <p className="mt-2 text-destructive">{error}</p>}
      <Button className="mt-3" size="sm" onClick={handleResync} disabled={publishing}>
        {publishing ? t('publishing') : t('resyncSearch')}
      </Button>
    </div>
  )
}
