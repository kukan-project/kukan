'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Settings2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { PipelineStatusDetail } from './pipeline-status-detail'
import { ResourcePreview } from './resource-preview'

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
  const router = useRouter()
  const [previewKey, setPreviewKey] = useState(0)
  const [open, setOpen] = useState(false)

  const handleSettled = useCallback(() => {
    setPreviewKey((k) => k + 1)
    router.refresh()
  }, [router])

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t('preview')}</h2>
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
