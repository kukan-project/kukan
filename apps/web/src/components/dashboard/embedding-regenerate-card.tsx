'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { useVectorSearchSettings } from '@/hooks/use-vector-search-settings'

/**
 * Regenerate the vectors semantic search reads (ADR-054). It marks every
 * resource and leaves the rest to the embed job, which skips a resource whose
 * text and model have not changed.
 */
export function EmbeddingRegenerateCard() {
  const t = useTranslations('dashboard.adminAi')
  const tc = useTranslations('common')
  const vectorSettings = useVectorSearchSettings()
  const model = vectorSettings.data?.model ?? null

  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<boolean | null>(null)

  async function regenerate() {
    setBusy(true)
    setOutcome(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex-embeddings', { method: 'POST' })
      setOutcome(res.ok)
    } catch {
      setOutcome(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('regenerateTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t('regenerateDescription')}</p>
        {model && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('model')}: </span>
            <span className="font-mono text-xs">{model}</span>
          </p>
        )}
        {vectorSettings.error && (
          <p role="alert" className="text-sm text-destructive">
            {t('settingsUnavailable')}
          </p>
        )}
        {!vectorSettings.loading && !vectorSettings.error && !model && (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        )}
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={regenerate} disabled={model === null || busy}>
            <Sparkles className={`mr-2 h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            {busy ? tc('queueing') : t('regenerateButton')}
          </Button>
          {outcome === true && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('regenerateQueued')}
            </p>
          )}
          {outcome === false && (
            <p role="alert" className="text-sm text-destructive">
              {tc('queueFailed')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
