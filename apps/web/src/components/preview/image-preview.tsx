'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { PreviewSkeleton, PreviewError } from './resource-preview'

interface ImagePreviewProps {
  resourceId: string
}

export function ImagePreview({ resourceId }: ImagePreviewProps) {
  const t = useTranslations('resource')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const previewUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`

  if (state === 'error') return <PreviewError />

  return (
    <>
      {state === 'loading' && <PreviewSkeleton />}
      <div
        className="overflow-hidden rounded-lg border"
        style={state === 'loading' ? { position: 'absolute', visibility: 'hidden' } : undefined}
      >
        <div className="flex max-h-[700px] items-center justify-center overflow-auto bg-muted/20 p-4">
          <img
            src={previewUrl}
            alt={t('preview')}
            className="max-h-[668px] max-w-full object-contain"
            onLoad={() => setState('ready')}
            onError={() => setState('error')}
          />
        </div>
      </div>
    </>
  )
}
