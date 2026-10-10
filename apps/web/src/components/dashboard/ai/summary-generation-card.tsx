'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldControl,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import { SUMMARIZE_ALL_JOB_TYPE, SUMMARIZE_PACKAGE_JOB_TYPE } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { useQueuedWorkPoll } from '@/hooks/use-queued-work-poll'
import { useSummaryEstimate, type SummaryEstimate } from '@/hooks/use-summary-estimate'

type SummaryAction = 'summaryFill' | 'summaryRefresh'
type SummaryLocale = SummaryEstimate['locale']

const SUMMARY_LOCALES: SummaryLocale[] = ['ja', 'en']

/** The jobs a bulk generation runs as: the fan-out and one per package */
const SUMMARY_JOB_TYPES: ReadonlySet<string> = new Set([
  SUMMARIZE_ALL_JOB_TYPE,
  SUMMARIZE_PACKAGE_JOB_TYPE,
])

/**
 * Bulk generation of resource abstracts (ADR-053). With the other bulk AI
 * action rather than the search index: what it rebuilds is what the AI wrote
 * about a dataset. The price below is that of the abstract model.
 */
export function SummaryGenerationCard({
  onRunningChange,
}: {
  /** Told whether a queued generation is still running, for what else follows it */
  onRunningChange?: (running: boolean) => void
} = {}) {
  const t = useTranslations('dashboard.adminAi')
  const tc = useTranslations('common')
  const { resourceSummaryEnabled } = useSiteSettings()
  // Asked for only where abstracts exist, and read before either button is
  // pressed: this is the one control that spends per resource (ADR-053 §11.2)
  const summaryEstimate = useSummaryEstimate(resourceSummaryEnabled === true)
  const estimate = summaryEstimate.estimate
  const skippedCount = estimate
    ? estimate.skipped.tooLarge + estimate.skipped.unsupportedFormat + estimate.skipped.noMaterial
    : 0
  const [busy, setBusy] = useState<SummaryAction | null>(null)
  const [outcome, setOutcome] = useState<{ action: SummaryAction; ok: boolean } | null>(null)
  // Once a generation is queued it is followed until its jobs are gone, and
  // the estimate read again on the way. Not until the estimate reaches zero: a
  // resource the job skips (no material to write from) stays in it
  const queued = outcome?.ok ? outcome.action : null
  const [jobsLeft, setJobsLeft] = useState<number | null>(null)
  const readJobs = useCallback(async (): Promise<number | null> => {
    try {
      const res = await clientFetch('/api/v1/admin/queue/counts')
      if (!res.ok) return null
      const { items }: { items: { type: string; status: string; count: number }[] } =
        await res.json()
      const left = items
        .filter((job) => SUMMARY_JOB_TYPES.has(job.type) && job.status !== 'dead')
        .reduce((sum, job) => sum + job.count, 0)
      setJobsLeft(left)
      return left
    } catch {
      // What is shown stays; the next read tries again
      return null
    }
  }, [])
  const running = queued !== null && jobsLeft !== 0
  const { reload: reloadEstimate } = summaryEstimate
  const follow = useCallback(async () => {
    const [, left] = await Promise.all([reloadEstimate(), readJobs()])
    // Once more when the jobs are gone: the read beside it may predate the last write
    if (left === 0) await reloadEstimate()
  }, [reloadEstimate, readJobs])
  useQueuedWorkPoll(follow, running)
  useEffect(() => onRunningChange?.(running), [running, onRunningChange])
  // The language picked but not yet saved; null follows the saved one
  const [locale, setLocale] = useState<SummaryLocale | null>(null)
  const [localeSave, setLocaleSave] = useState<'saving' | 'saved' | 'failed' | null>(null)
  const localeDirty = locale !== null && locale !== estimate?.locale

  async function saveLocale() {
    if (!locale) return
    setLocaleSave('saving')
    try {
      const res = await clientFetch('/api/v1/admin/settings/ai-summary-locale', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: locale }),
      })
      if (!res.ok) {
        setLocaleSave('failed')
        return
      }
      setLocaleSave('saved')
      setLocale(null)
      setOutcome(null)
      // The estimate counts what the saved language leaves to rewrite
      void summaryEstimate.reload()
    } catch {
      setLocaleSave('failed')
    }
  }

  async function generate(action: SummaryAction) {
    setBusy(action)
    setOutcome(null)
    try {
      const res = await clientFetch('/api/v1/admin/generate-summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: action === 'summaryRefresh' }),
      })
      if (res.ok) setJobsLeft(null)
      setOutcome({ action, ok: res.ok })
      if (res.ok) void follow()
    } catch {
      setOutcome({ action, ok: false })
    } finally {
      setBusy(null)
    }
  }

  if (!resourceSummaryEnabled) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('summaryTitle')}</CardTitle>
      </CardHeader>
      {/* Each action carries its own count and its own price, because they are
          different amounts of money for different reasons and a reader has to
          be able to tell which button costs which (ADR-053 §11.2). */}
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('summaryDescription')}</p>
        {estimate?.model && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('summaryModel')}: </span>
            <span className="font-mono text-xs">{estimate.model}</span>
          </p>
        )}
        {estimate && (
          // Changing it rewrites nothing on its own: the rewrite is the second
          // button below, whose count the saved language changes
          <Field description={t('summaryLocaleHint')}>
            <FieldLabel>{t('summaryLocale')}</FieldLabel>
            <div className="flex flex-wrap items-center gap-4">
              <Select
                value={locale ?? estimate.locale}
                onValueChange={(value) => {
                  setLocale(value as SummaryLocale)
                  setLocaleSave(null)
                }}
              >
                <FieldControl>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                </FieldControl>
                <SelectContent>
                  {SUMMARY_LOCALES.map((l) => (
                    <SelectItem key={l} value={l}>
                      {t(`summaryLocaleName.${l}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={saveLocale}
                disabled={!localeDirty || localeSave === 'saving'}
              >
                {tc('save')}
              </Button>
              {localeSave === 'saved' && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('summaryLocaleSaved')}
                </p>
              )}
              {localeSave === 'failed' && (
                <p role="alert" className="text-sm text-destructive">
                  {t('summaryLocaleSaveFailed')}
                </p>
              )}
            </div>
          </Field>
        )}

        {summaryEstimate.loading && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('summaryEstimateLoading')}
          </p>
        )}
        {summaryEstimate.error && (
          <p role="alert" className="text-sm text-destructive">
            {t('summaryEstimateUnavailable')}
          </p>
        )}

        {(['summaryFill', 'summaryRefresh'] as const).map((action) => {
          const op = estimate && operationOf(estimate, action)
          return (
            <div key={action} className="flex flex-col gap-2 rounded-md border p-3">
              <p className="text-sm">{t(`${action}Scope`)}</p>
              {op && (
                <p className="text-sm text-muted-foreground">
                  {/* Both bounds, because the money beside them is a range: one
                      number against a range reads as though the high token
                      count cost the low price. What nobody can see from here is
                      a PDF's page count, and that is the whole width of the
                      span. */}
                  {t('summaryEstimate', {
                    resources: op.resources,
                    inputLow: op.estimatedInputTokens.low,
                    inputHigh: op.estimatedInputTokens.high,
                    output: op.estimatedOutputTokens,
                  })}
                  {op.estimatedCostUsd &&
                    ' ' +
                      t('summaryCost', {
                        low: op.estimatedCostUsd.low.toFixed(2),
                        high: op.estimatedCostUsd.high.toFixed(2),
                      })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-4">
                <Button
                  variant="outline"
                  onClick={() => generate(action)}
                  // No estimate, no button. The card exists so that what this
                  // costs is read before it is spent, and "still loading" and
                  // "the estimate failed" are both states where that has not
                  // happened.
                  // Nor while a generation runs: its count is still moving
                  disabled={busy !== null || running || !op || op.resources === 0}
                >
                  <Sparkles className={`mr-2 h-4 w-4 ${busy === action ? 'animate-spin' : ''}`} />
                  {busy === action ? tc('queueing') : t(`${action}Button`)}
                </Button>
                {outcome?.action === action &&
                  (outcome.ok ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t(running ? 'summaryQueued' : 'summaryDone')}
                    </p>
                  ) : (
                    <p role="alert" className="text-sm text-destructive">
                      {tc('queueFailed')}
                    </p>
                  ))}
              </div>
            </div>
          )
        })}

        {/* Counted among the resources with no abstract, not across the whole
            catalogue: it sits under the buttons, so it reads as what they will
            not cover — and a file already described is not out of scope,
            whatever it weighs. */}
        {skippedCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('summarySkipped', { count: skippedCount })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function operationOf(estimate: SummaryEstimate, action: SummaryAction) {
  return action === 'summaryFill' ? estimate.fill : estimate.refresh
}
