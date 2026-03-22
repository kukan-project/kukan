'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Settings2 } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@kukan/ui'
import { useTranslations, useLocale } from 'next-intl'
import { PipelineStatusDetail } from './pipeline-status-detail'
import { ResourcePreview } from './resource-preview'
import { formatDateTime } from './date-time'
import { useFetch } from '@/hooks/use-fetch'
import type { PipelineStatusData } from '@/hooks/use-pipeline-status'

interface ResourcePipelinePreviewProps {
  resourceId: string
  format?: string | null
  canManage?: boolean
}

/**
 * Preview section with optional pipeline management dialog.
 * The dialog shows pipeline status and reprocess button.
 * When pipeline completes, the preview re-mounts and page data refreshes.
 */
export function ResourcePipelinePreview({
  resourceId,
  format,
  canManage,
}: ResourcePipelinePreviewProps) {
  const t = useTranslations('resource')
  const locale = useLocale()
  const router = useRouter()
  const [previewKey, setPreviewKey] = useState(0)
  const [open, setOpen] = useState(false)

  // previewKey in path triggers re-fetch after reprocess
  const { data: pipelineData } = useFetch<PipelineStatusData>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/pipeline-status?_k=${previewKey}`
  )

  const handleSettled = useCallback(() => {
    setPreviewKey((k) => k + 1)
    router.refresh()
  }, [router])

  const generatedAt =
    pipelineData?.pipeline_status === 'complete' && pipelineData.updated
      ? formatDateTime(pipelineData.updated, locale)
      : null

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">{t('preview')}</h2>
          {generatedAt && (
            <span className="text-xs text-muted-foreground">
              {t('previewGeneratedAt', { date: generatedAt })}
            </span>
          )}
        </div>
        {canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" title={t('pipelineStatus')}>
                <Settings2 className="size-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t('pipelineStatus')}</DialogTitle>
              </DialogHeader>
              <PipelineStatusDetail resourceId={resourceId} onSettled={handleSettled} />
            </DialogContent>
          </Dialog>
        )}
      </div>
      <ResourcePreview key={previewKey} resourceId={resourceId} format={format} />
    </section>
  )
}
