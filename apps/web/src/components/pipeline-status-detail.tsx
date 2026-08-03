'use client'

import { Alert, AlertDescription, Badge, Button } from '@kukan/ui'
import { RefreshCw, Undo2, Wrench, X } from 'lucide-react'
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
 * Regenerate the derivatives from the object the resource already holds.
 *
 * Offered beside the plain reprocess rather than only after a failure, because
 * the repair has to outlive the screen: this view lives in a dialog, and a
 * revert whose rebuild fails later leaves whoever comes back — a reload, a
 * different admin — with nothing but the reprocess, which re-reads an external
 * URL and undoes the revert (ADR-044 §4). Stateless and safe to press at any
 * time, so nothing has to be remembered for it to be available.
 */
function RebuildButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const t = useTranslations('resource')
  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={disabled}>
      <Wrench className="mr-1 size-3" />
      {t('rebuildDerivatives')}
    </Button>
  )
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
  const { status, steps, error, revertTarget, liveRevision, refetch } = usePipelineStatus({
    resourceId,
    onSettled,
  })
  // At most one action can be in flight, so one value rather than a flag each —
  // which also makes "something is running, disable the others" a single check.
  const [busy, setBusy] = useState<'run-pipeline' | 'cancel-pipeline' | 'revert' | null>(null)
  // The revert the user was shown, frozen when the dialog opened. Polling keeps
  // moving the live target underneath, so sending whatever is current at confirm
  // time can retract content they never saw. Kept afterwards too: an outcome
  // nobody knows is retried with this same pair, and a fresh one would be the
  // next rung down (ADR-044 §4).
  const [pending, setPending] = useState<{
    restoreTo: number | null
    ifLiveRevision: string
  } | null>(null)
  // Separate from `pending`, because the pair outlives the dialog: a revert
  // that left work behind keeps it for the retry, and tying the two together
  // left that retry behind a modal that discards it on close.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The action whose request did not land, so the screen can say the operation
  // did not happen rather than silently refreshing as if it had.
  const [failed, setFailed] = useState<
    'run-pipeline' | 'cancel-pipeline' | 'revert' | 'stale' | null
  >(null)
  // A revert that completed but left work behind. Repaired by resending the
  // same pair, whether or not anything was restored — the server answers a
  // resend with a rebuild either way.
  const [partial, setPartial] = useState(false)

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

  // The Version step settles whether the current content was created: complete
  // means it was, skipped means an identical version already existed. Anything
  // else — missing, running, failed — means it was not, and replacing the file
  // would lose it (ADR-044 §4).
  const versionStep = steps.find((s) => s.step_name === 'version')
  const versionSaved = versionStep?.status === 'complete' || versionStep?.status === 'skipped'

  // None of these return the new pipeline state, so each ends by refetching it.
  //
  // A non-OK response has to be read: `fetch` resolves on a 500, so treating it
  // as done closed the dialog on operations that never ran. It matters most for
  // the revert, where "it did not run" and "it ran and left work behind" need
  // different answers — the first invites another attempt, the second must not.
  async function post(action: 'run-pipeline' | 'cancel-pipeline' | 'revert', body?: unknown) {
    const rebuild = action === 'run-pipeline' && body !== undefined
    setBusy(action)
    setFailed(null)
    // The warning stands until something reports the work is done: cleared on
    // the way in, a repair that fails takes the only pointer to it with it. A
    // plain reprocess rebuilds both derivatives, so that one does clear it.
    if (!rebuild) setPartial(false)
    try {
      const res = await clientFetch(
        `/api/v1/resources/${encodeURIComponent(resourceId)}/${action}`,
        {
          method: 'POST',
          ...(body !== undefined && {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        }
      )
      if (!res.ok) {
        // The server answered, so this did not happen. A 4xx is a settled
        // verdict on the pair the request carried — the generation has moved,
        // the version is gone, the caller may not — and resending it can only
        // be refused again, so it is dropped and the next attempt starts from a
        // fresh reading. A 5xx may be transient, and the operation is
        // idempotent, so there the pair is worth keeping.
        const settled = res.status < 500
        setFailed(res.status === 409 ? 'stale' : action)
        if (settled) setPending(null)
        refetch()
        return
      }
      // The two actions that answer with what they left behind. A revert says
      // whether its cleanup finished, in one field.
      //
      // The repair answers in whichever shape it took, and the other field is
      // not an answer: an emptied resource reports `cleared` and queues
      // nothing, one with content reports `queued` and leaves `cleared` null.
      // Reading `cleared` alone is what let a queue that is down clear the
      // warning — nothing was cleared and nothing was queued, and the two
      // falses read as a repair that happened.
      if (action === 'revert' || rebuild) {
        const result = (await res.json()) as {
          cleanedUp?: boolean
          queued?: boolean
          cleared?: boolean | null
        }
        const done = rebuild
          ? (result.cleared ?? result.queued ?? false)
          : result.cleanedUp !== false
        setPartial(!done)
      }
      refetch()
    } catch {
      // A request that never landed and one whose answer was lost look the
      // same from here, so neither is reported as "nothing happened". Refetch
      // so the screen shows which it was; the operation is idempotent, so
      // trying again from that state is safe (ADR-044 §4).
      setFailed(action)
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
                  onClick={() => {
                    if (!liveRevision) return
                    setPending({ restoreTo: revertTarget, ifLiveRevision: liveRevision })
                    setConfirmOpen(true)
                  }}
                  disabled={busy !== null || !liveRevision}
                >
                  <Undo2 className="mr-1 size-3" />
                  {busy === 'revert' ? t('revertingRun') : t('revertRun')}
                </Button>
              </>
            )}
            {!isRunning && (
              <>
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
                <RebuildButton
                  disabled={busy !== null}
                  onClick={() => post('run-pipeline', { rebuildOnly: true })}
                />
              </>
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
          <RebuildButton
            disabled={busy !== null}
            onClick={() => post('run-pipeline', { rebuildOnly: true })}
          />
        </div>
      )}

      {/* What a stopped run leaves behind depends on how far it got, and the
          case worth naming is the content that was never created as a version:
          replacing the file loses it for good (ADR-044 §4). Nothing else on
          this screen would say so. */}
      {status === 'cancelled' && (
        <Alert>
          <AlertDescription>
            {t(versionSaved ? 'cancelledNotice' : 'cancelledNoticeUnsaved')}
          </AlertDescription>
        </Alert>
      )}

      {failed && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center justify-between gap-2">
            {t(failed === 'stale' ? 'actionStale' : 'actionFailed')}
            {/* The same pair, never a freshly read one — that would be the next
                rung down rather than this operation again (ADR-044 §4). */}
            {failed === 'revert' && pending && (
              <Button variant="outline" size="sm" onClick={() => post('revert', pending)}>
                {t('revertRetry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {partial && (
        <Alert variant="warning" role="alert">
          <AlertDescription>{t('revertPartial')}</AlertDescription>
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
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('revertConfirmTitle')}
        description={t('revertConfirmDescription')}
        isDeleting={busy === 'revert'}
        confirmLabel={t('revertRun')}
        confirmingLabel={t('revertingRun')}
        onConfirm={async () => {
          // The frozen pair, echoed back untouched.
          if (pending) await post('revert', pending)
          setConfirmOpen(false)
        }}
      />
    </div>
  )
}
