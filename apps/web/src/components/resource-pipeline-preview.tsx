'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Settings2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@kukan/ui'
import { useTranslations, useLocale } from 'next-intl'
import { isCsvFormat, type ResourceSchema } from '@kukan/shared'
import { PipelineStatusDetail } from './pipeline-status-detail'
import { ResourcePreview } from './resource-preview'
import { ResourceFields } from './resource-fields'
import { DataApiDialog } from './data-api-dialog'
import { formatDateTime } from './date-time'
import { useFetch } from '@/hooks/use-fetch'
import type { PipelineStatusData } from '@/hooks/use-pipeline-status'

interface ResourcePipelinePreviewProps {
  resourceId: string
  format?: string | null
  url?: string | null
  size?: number | null
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
  url,
  size,
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

  // One read for everything on this page that describes the table: the
  // dropped-rows note, the key marking in both preview modes, and the fields
  // list. Only tabular formats have any of that to say.
  const { data: schemaData } = useFetch<{
    schema: ResourceSchema | null
    primaryKey: string[] | null
  }>(
    isCsvFormat(format)
      ? `/api/v1/resources/${encodeURIComponent(resourceId)}/schema?_k=${previewKey}`
      : null
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
          <h4 className="text-xl font-semibold">{t('preview')}</h4>
          {generatedAt && (
            <span className="text-xs text-muted-foreground">
              {t('previewGeneratedAt', { date: generatedAt })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* An empty schema (interpretation produced no table) is persisted too,
              and querying it only 400s — so require at least one column. */}
          {schemaData?.schema && schemaData.schema.columns.length > 0 && (
            <DataApiDialog resourceId={resourceId} schema={schemaData.schema} />
          )}
          {canManage && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t('pipelineStatus')}
                  aria-label={t('pipelineStatus')}
                >
                  <Settings2 className="size-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{t('pipelineStatus')}</DialogTitle>
                  <DialogDescription>{t('pipelineStatusDescription')}</DialogDescription>
                </DialogHeader>
                <PipelineStatusDetail resourceId={resourceId} onSettled={handleSettled} />
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      <ResourcePreview
        key={`${resourceId}-${previewKey}`}
        resourceId={resourceId}
        format={format}
        url={url}
        size={size}
        schema={schemaData?.schema}
        primaryKey={schemaData?.primaryKey}
      />
      {/* Field (column) list shares the preview's remount key so it refreshes
          in lockstep when the pipeline (re)generates the Parquet preview. */}
      {isCsvFormat(format) && (
        <div className="mt-6">
          <ResourceFields
            key={`fields-${resourceId}-${previewKey}`}
            resourceId={resourceId}
            primaryKey={schemaData?.primaryKey}
          />
        </div>
      )}
    </section>
  )
}
