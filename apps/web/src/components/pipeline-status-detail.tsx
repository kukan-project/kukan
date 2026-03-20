'use client'

import { Badge, Button } from '@kukan/ui'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePipelineStatus, type PipelineStatus } from '@/hooks/use-pipeline-status'
import { clientFetch } from '@/lib/client-api'

interface PipelineStatusDetailProps {
  resourceId: string
  canManage?: boolean
  /** Called when pipeline reaches a terminal state after reprocessing */
  onPipelineComplete?: () => void
}

const STEP_LABEL_KEYS: Record<string, string> = {
  fetch: 'pipelineStepFetch',
  extract: 'pipelineStepExtract',
  index: 'pipelineStepIndex',
}

const STEP_STATUS_KEYS: Record<string, string> = {
  running: 'pipelineStepRunning',
  complete: 'pipelineStepComplete',
  error: 'pipelineStepError',
  skipped: 'pipelineStepSkipped',
  pending: 'pipelineStepPending',
}

function getStepBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
      return 'default'
    case 'complete':
      return 'secondary'
    case 'error':
      return 'destructive'
    default:
      return 'outline'
  }
}

function getDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  return (ms / 1000).toFixed(1)
}

const STATUS_BADGE_VARIANTS: Record<
  PipelineStatus,
  'outline' | 'default' | 'secondary' | 'destructive'
> = {
  queued: 'outline',
  processing: 'default',
  complete: 'secondary',
  error: 'destructive',
}

export function PipelineStatusDetail({
  resourceId,
  canManage = false,
  onPipelineComplete,
}: PipelineStatusDetailProps) {
  const t = useTranslations('resource')
  const { data, status, steps, error, refetch } = usePipelineStatus({
    resourceId,
    onSettled: onPipelineComplete,
  })
  const [reprocessing, setReprocessing] = useState(false)

  // Not visible to users without manage permission
  if (!canManage) return null

  async function handleReprocess() {
    setReprocessing(true)
    try {
      await clientFetch(`/api/v1/resources/${resourceId}/run-pipeline`, { method: 'POST' })
      refetch()
    } finally {
      setReprocessing(false)
    }
  }

  // No pipeline record yet — show process button
  if (!data || !status) {
    return (
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{t('pipelineStatus')}</h3>
        <Button variant="outline" size="sm" onClick={handleReprocess} disabled={reprocessing}>
          <RefreshCw className={`mr-1 size-3 ${reprocessing ? 'animate-spin' : ''}`} />
          {reprocessing ? t('reprocessing') : t('reprocessResource')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{t('pipelineStatus')}</h3>
          <Badge variant={STATUS_BADGE_VARIANTS[status]}>
            {t(
              status === 'queued'
                ? 'pipelineQueued'
                : status === 'processing'
                  ? 'pipelineProcessing'
                  : status === 'complete'
                    ? 'pipelineComplete'
                    : 'pipelineError'
            )}
          </Badge>
        </div>
        {(status === 'complete' || status === 'error') && (
          <Button variant="outline" size="sm" onClick={handleReprocess} disabled={reprocessing}>
            <RefreshCw className={`mr-1 size-3 ${reprocessing ? 'animate-spin' : ''}`} />
            {reprocessing ? t('reprocessing') : t('reprocessResource')}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {steps.length > 0 && (
        <div className="flex flex-col gap-2">
          {steps.map((step) => {
            const duration = getDuration(step.started_at, step.completed_at)
            return (
              <div
                key={step.step_name}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {t(STEP_LABEL_KEYS[step.step_name] || step.step_name)}
                  </span>
                  <Badge variant={getStepBadgeVariant(step.status)} className="text-xs">
                    {t(STEP_STATUS_KEYS[step.status] || step.status)}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {step.error && (
                    <span className="max-w-[200px] truncate text-destructive" title={step.error}>
                      {step.error}
                    </span>
                  )}
                  {duration && <span>{t('pipelineDuration', { duration })}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
