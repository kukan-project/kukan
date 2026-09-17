'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { useSummaryEstimate } from '@/hooks/use-summary-estimate'

type SummaryAction = 'summaryFill' | 'summaryRefresh'

/**
 * Bulk generation of resource abstracts (ADR-053). Beside the model settings
 * rather than the search index: what it rebuilds is what the AI wrote about a
 * dataset, and the price below is the price of the model chosen just above.
 */
export function SummaryGenerationCard() {
  const t = useTranslations('dashboard.adminSite')
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

  async function generate(action: SummaryAction) {
    setBusy(action)
    setOutcome(null)
    try {
      const res = await clientFetch('/api/v1/admin/generate-summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: action === 'summaryRefresh' }),
      })
      setOutcome({ action, ok: res.ok })
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
          <p className="flex flex-wrap gap-x-4 text-sm">
            <span>
              <span className="text-muted-foreground">{t('summaryModel')}: </span>
              <span className="font-mono text-xs">{estimate.model}</span>
            </span>
            <span>
              <span className="text-muted-foreground">{t('summaryLocale')}: </span>
              {t(`summaryLocaleName.${estimate.locale}`)}
            </span>
          </p>
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
          const op = estimate && (action === 'summaryFill' ? estimate.fill : estimate.refresh)
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
                  disabled={busy !== null || !op || op.resources === 0}
                >
                  <Sparkles className={`mr-2 h-4 w-4 ${busy === action ? 'animate-spin' : ''}`} />
                  {busy === action ? tc('queueing') : t(`${action}Button`)}
                </Button>
                {outcome?.action === action &&
                  (outcome.ok ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t('summaryQueued')}
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
