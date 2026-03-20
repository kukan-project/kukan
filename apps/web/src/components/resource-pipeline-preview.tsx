'use client'

import { useState, useCallback } from 'react'
import { Separator } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { PipelineStatusDetail } from './pipeline-status-detail'
import { ResourcePreview } from './resource-preview'

interface ResourcePipelinePreviewProps {
  resourceId: string
  format?: string | null
  canManage: boolean
}

/**
 * Coordinates pipeline status and preview sections.
 * When the pipeline completes, the preview re-mounts to fetch fresh data.
 */
export function ResourcePipelinePreview({
  resourceId,
  format,
  canManage,
}: ResourcePipelinePreviewProps) {
  const t = useTranslations('resource')
  const [previewKey, setPreviewKey] = useState(0)

  const handlePipelineComplete = useCallback(() => {
    setPreviewKey((k) => k + 1)
  }, [])

  return (
    <>
      <PipelineStatusDetail
        resourceId={resourceId}
        canManage={canManage}
        onPipelineComplete={handlePipelineComplete}
      />

      <Separator />

      <section>
        <h2 className="mb-4 text-xl font-semibold">{t('preview')}</h2>
        <ResourcePreview key={previewKey} resourceId={resourceId} format={format} />
      </section>
    </>
  )
}
