'use client'

import { Alert, AlertDescription, Badge, Button } from '@kukan/ui'
import { RefreshCw, Undo2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { LegacyPipelineStepName, PipelineStepName } from '@kukan/shared'
import { usePipelineStatus, type PipelineStatus } from '@/hooks/use-pipeline-status'
import { STATUS_KEYS } from '@/components/dashboard/dataset/pipeline-status-badge'
import { clientFetch } from '@/lib/client-api'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'

interface PipelineStatusDetailProps {
  resourceId: string
  /** Called when pipeline reaches a terminal state after reprocessing */
  onSettled?: (status: PipelineStatus) => void
}

// Typed by the step names so adding one forces a label rather than
// silently rendering the raw step id. Retired names are labelled too: a run
// clears its steps at the start, so rows written under the old name are still
// on screen until each resource has run again (ADR-046).
const STEP_LABEL_KEYS: Record<PipelineStepName | LegacyPipelineStepName, string> = {
  fetch: 'pipelineStepFetch',
  version: 'pipelineStepVersion',
  interpret: 'pipelineStepInterpret',
  lake: 'pipelineStepLake',
  index: 'pipelineStepIndex',
  extract: 'pipelineStepExtract',
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

/**
 * How long the run has been going, read from its first step.
 *
 * Recomputed on each poll rather than ticked by a timer of its own: the number
 * is there to tell a run that is working from one that is wedged, and a
 * poll-rate resolution answers that.
 */
function getElapsed(steps: { started_at: string | null }[]): string | null {
  const first = steps.find((s) => s.started_at !== null)?.started_at
  if (!first) return null
  const seconds = Math.floor((Date.now() - new Date(first).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000

const STATUS_BADGE_VARIANTS: Record<
  PipelineStatus,
  'outline' | 'default' | 'secondary' | 'destructive'
> = {
  pending: 'outline',
  queued: 'outline',
  processing: 'default',
  complete: 'secondary',
  error: 'destructive',
  cancelled: 'secondary',
}

/**
 * Pipeline status display with reprocess button.
 * Polls automatically; fires onSettled when pipeline reaches terminal state.
 */
export function PipelineStatusDetail({ resourceId, onSettled }: PipelineStatusDetailProps) {
  const t = useTranslations('resource')
  // Do NOT set initialActive here: merely opening the status view must not be
  // treated as an in-flight reprocess, or onSettled would fire immediately on an
  // already-complete pipeline (triggering a refresh that closes the dialog).
  // A real reprocess goes through refetch(), which arms onSettled itself.
  const { status, steps, error, refetch } = usePipelineStatus({
    resourceId,
    onSettled,
  })
  // At most one action can be in flight, so one value rather than a flag each —
  // which also makes "something is running, disable the others" a single check.
  const [busy, setBusy] = useState<'run-pipeline' | 'cancel-pipeline' | 'revert' | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)

  // Detect stuck pipelines: processing with a step running for 5+ minutes
  const stuck =
    status === 'processing' &&
    steps.some(
      (s) =>
        s.status === 'running' &&
        s.started_at &&
        Date.now() - new Date(s.started_at).getTime() > STUCK_THRESHOLD_MS
    )
  const active = status === 'queued' || status === 'processing'
  // A stalled run is still active — it just stops counting as healthy, which is
  // what decides the badge and whether reprocessing is offered.
  const isRunning = active && !stuck
  const elapsed = active ? getElapsed(steps) : null

  // The Version step settles whether the current content was captured: complete
  // means it was, skipped means an identical version already existed. Anything
  // else — missing, running, failed — means it was not, and replacing the file
  // would lose it (ADR-044 §4).
  const versionStep = steps.find((s) => s.step_name === 'version')
  const versionSaved = versionStep?.status === 'complete' || versionStep?.status === 'skipped'

  // None of these return the new pipeline state, so each ends by refetching it.
  async function post(action: 'run-pipeline' | 'cancel-pipeline' | 'revert') {
    setBusy(action)
    try {
      await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/${action}`, {
        method: 'POST',
      })
      refetch()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant={stuck ? 'destructive' : STATUS_BADGE_VARIANTS[status]}>
              {t(stuck ? 'pipelineStuck' : STATUS_KEYS[status])}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {elapsed && (
              <span className="text-xs text-muted-foreground">
                {t('pipelineElapsed', { duration: elapsed })}
              </span>
            )}
            {/* Stopping is offered whenever something is running, including a
                run that looks stalled — waiting out the staleness window is
                exactly what an operator who already knows should not have to
                do (ADR-044 §4). */}
            {active && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => post('cancel-pipeline')}
                  disabled={busy !== null}
                >
                  <X className="mr-1 size-3" />
                  {busy === 'cancel-pipeline' ? t('cancellingRun') : t('cancelRun')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmRevert(true)}
                  disabled={busy !== null}
                >
                  <Undo2 className="mr-1 size-3" />
                  {busy === 'revert' ? t('revertingRun') : t('revertRun')}
                </Button>
              </>
            )}
            {!isRunning && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => post('run-pipeline')}
                disabled={busy !== null}
              >
                <RefreshCw
                  className={`mr-1 size-3 ${busy === 'run-pipeline' ? 'animate-spin' : ''}`}
                />
                {busy === 'run-pipeline' ? t('reprocessing') : t('reprocessResource')}
              </Button>
            )}
          </div>
        </div>
      )}

      {!status && (
        <div className="flex items-center justify-center py-4">
          <Button variant="outline" onClick={() => post('run-pipeline')} disabled={busy !== null}>
            <RefreshCw className={`mr-1 size-4 ${busy === 'run-pipeline' ? 'animate-spin' : ''}`} />
            {busy === 'run-pipeline' ? t('reprocessing') : t('reprocessResource')}
          </Button>
        </div>
      )}

      {/* What a stopped run leaves behind depends on how far it got, and the
          case worth naming is the content that was never captured as a version:
          replacing the file loses it for good (ADR-044 §4). Nothing else on
          this screen would say so. */}
      {status === 'cancelled' && (
        <Alert>
          <AlertDescription>
            {t(versionSaved ? 'cancelledNotice' : 'cancelledNoticeUnsaved')}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
                    {t(
                      STEP_LABEL_KEYS[step.step_name as keyof typeof STEP_LABEL_KEYS] ||
                        step.step_name
                    )}
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

      <DeleteConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        title={t('revertConfirmTitle')}
        description={t('revertConfirmDescription')}
        isDeleting={busy === 'revert'}
        confirmLabel={t('revertRun')}
        confirmingLabel={t('revertingRun')}
        onConfirm={async () => {
          await post('revert')
          setConfirmRevert(false)
        }}
      />
    </div>
  )
}
