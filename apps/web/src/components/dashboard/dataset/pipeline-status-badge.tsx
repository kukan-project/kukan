'use client'

import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { usePipelineStatus, type PipelineStatus } from '@/hooks/use-pipeline-status'

interface PipelineStatusBadgeProps {
  resourceId: string
  initialStatus?: PipelineStatus | null
}

const STATUS_CONFIG: Record<
  PipelineStatus,
  { variant: 'outline' | 'default' | 'secondary' | 'destructive'; className?: string }
> = {
  queued: { variant: 'outline' },
  processing: { variant: 'default', className: 'animate-pulse' },
  complete: {
    variant: 'secondary',
    className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  },
  error: { variant: 'destructive' },
}

export const STATUS_KEYS: Record<PipelineStatus, string> = {
  queued: 'pipelineQueued',
  processing: 'pipelineProcessing',
  complete: 'pipelineComplete',
  error: 'pipelineError',
}

export function PipelineStatusBadge({ resourceId, initialStatus }: PipelineStatusBadgeProps) {
  const t = useTranslations('resource')
  const shouldPoll = initialStatus === 'queued' || initialStatus === 'processing'
  const { status } = usePipelineStatus({
    resourceId,
    enabled: shouldPoll,
    initialStatus,
  })

  if (!status) return null

  const config = STATUS_CONFIG[status]
  const label = t(STATUS_KEYS[status])

  return (
    <Badge variant={config.variant} className={config.className}>
      {label}
    </Badge>
  )
}
