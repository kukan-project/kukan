'use client'

import { Badge, Button } from '@kukan/ui'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePipelineStatus, type PipelineStatus } from '@/hooks/use-pipeline-status'
import { clientFetch } from '@/lib/client-api'

interface PipelineStatusDetailProps {
  resourceId: string
  /** Called when pipeline reaches a terminal state after reprocessing */
  onSettled?: (status: PipelineStatus) => void
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

/**
 * Pipeline status display with reprocess button.
 * Polls automatically; fires onSettled when pipeline reaches terminal state.
 */
export function PipelineStatusDetail({ resourceId, onSettled }: PipelineStatusDetailProps) {
  const t = useTranslations('resource')
  const { status, steps, error, refetch } = usePipelineStatus({
    resourceId,
    initialActive: true,
    onSettled,
  })
  const [reprocessing, setReprocessing] = useState(false)
  const isRunning = status === 'queued' || status === 'processing'

  async function handleReprocess() {
    setReprocessing(true)
    try {
      await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/run-pipeline`, {
        method: 'POST',
      })
      refetch()
    } finally {
      setReprocessing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
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
          {!isRunning && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReprocess}
              disabled={reprocessing}
            >
              <RefreshCw className={`mr-1 size-3 ${reprocessing ? 'animate-spin' : ''}`} />
              {reprocessing ? t('reprocessing') : t('reprocessResource')}
            </Button>
          )}
        </div>
      )}

      {!status && (
        <div className="flex items-center justify-center py-4">
          <Button variant="outline" onClick={handleReprocess} disabled={reprocessing}>
            <RefreshCw className={`mr-1 size-4 ${reprocessing ? 'animate-spin' : ''}`} />
            {reprocessing ? t('reprocessing') : t('reprocessResource')}
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {steps.length > 0 && (
        <div className="flex flex-col gap-2">
          {steps.map((step) => {
            const duration = getDuration(step.started_at, step.completed_at)
            return (
              <div
                key={step.id}
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
