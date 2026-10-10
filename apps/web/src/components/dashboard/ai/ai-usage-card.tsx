'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Gauge } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@kukan/ui'
import {
  AI_PROVIDERS,
  AI_USAGE_PURPOSES,
  type AiUsageBucket,
  type AiUsageGranularity,
  type AiUsagePurpose,
  type AiUsageReport,
} from '@kukan/shared/ai-usage'
import { useLatestJson } from '@/hooks/use-latest-json'
import { useQueuedWorkPoll } from '@/hooks/use-queued-work-poll'
import { UsageChart, type UsageColumn, type UsageSeries } from './ai-usage-chart'

type Granularity = AiUsageGranularity
type Dimension = 'purpose' | 'model' | 'provider'
type Metric = 'cost' | 'tokens'
type UsageBucket = AiUsageBucket

const SERIES_COLORS = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5']
const OTHER = '__other'

/**
 * What the AI calls consumed and cost, per hour, day or month: this month's
 * total and projection above, a stacked chart by purpose, model or provider,
 * and the same totals as a table — the table is also what makes the chart's
 * lighter colours readable.
 */
export function AiUsageCard({
  following = false,
}: {
  /** Whether bulk AI work queued elsewhere on the page is running */
  following?: boolean
} = {}) {
  const t = useTranslations('dashboard.adminAi')
  const locale = useLocale()
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [dimension, setDimension] = useState<Dimension>('purpose')
  const [metric, setMetric] = useState<Metric>('cost')
  const {
    data,
    error,
    fetch: reload,
  } = useLatestJson<AiUsageReport>(`/api/v1/admin/ai-usage?granularity=${granularity}`)
  const loading = data === null && !error
  // Read again while bulk work elsewhere on the page runs, so its cost is seen
  // to grow, and once more when it ends, for the calls since the last read
  useQueuedWorkPoll(reload, following)
  const wasFollowing = useRef(following)
  useEffect(() => {
    if (wasFollowing.current && !following) void reload()
    wasFollowing.current = following
  }, [following, reload])

  const usd = useMemo(() => usdFormatter(locale), [locale])
  const count = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const compact = useMemo(
    () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    [locale]
  )

  const label = (key: string) => {
    if (key === OTHER) return t('usageOther')
    if (dimension === 'purpose') return t(`usagePurpose.${key as AiUsagePurpose}`)
    return key
  }
  const series = useMemo(() => (data ? seriesOf(data.buckets, dimension) : []), [data, dimension])
  const legend: UsageSeries[] = series.map((key, i) => ({
    key,
    label: label(key),
    color: key === OTHER ? 'var(--viz-other)' : `var(${SERIES_COLORS[i]})`,
  }))

  const format = (v: number) => (metric === 'cost' ? usd(v) : compact.format(v))

  const columns: UsageColumn[] = useMemo(() => {
    if (!data) return []
    const columns = data.periods.map((start) => ({
      start,
      label: formatPeriod(start, granularity, data.timeZone, locale, 'long'),
      values: {} as Record<string, number>,
    }))
    const byStart = new Map(columns.map((column) => [column.start, column.values]))
    for (const b of data.buckets) {
      const values = byStart.get(b.start)
      if (!values) continue
      const key = groupKey(b, dimension, series)
      values[key] = (values[key] ?? 0) + measure(b, metric)
    }
    return columns
  }, [data, dimension, series, metric, granularity, locale])

  const rows = useMemo(
    () => (data ? totalsOf(data.buckets, dimension, series) : []),
    [data, dimension, series]
  )
  const total = rows.reduce((sum, r) => addTotals(sum, r.totals), emptyTotals())
  const unpriced = data?.buckets.reduce((sum, b) => sum + b.unpricedCalls, 0) ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5" />
          {t('usageTitle')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('usageDescription')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && <p className="text-sm text-destructive">{t('usageLoadFailed')}</p>}

        {data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={t('usageMonthCost')} value={usd(data.month.costUsd)} />
            <Stat
              label={t('usageProjected')}
              value={data.month.projectedUsd === null ? '—' : usd(data.month.projectedUsd)}
              hint={data.month.projectedUsd === null ? t('usageProjectedPending') : undefined}
            />
            <Stat label={t('usageMonthCalls')} value={count.format(data.month.calls)} />
          </div>
        )}
        {data && data.month.unpricedCalls > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('usageMonthUnpriced', { count: data.month.unpricedCalls })}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
            <TabsList>
              <TabsTrigger value="hour">{t('usageHour')}</TabsTrigger>
              <TabsTrigger value="day">{t('usageDay')}</TabsTrigger>
              <TabsTrigger value="month">{t('usageMonth')}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={dimension} onValueChange={(v) => setDimension(v as Dimension)}>
            <TabsList>
              <TabsTrigger value="purpose">{t('usageByPurpose')}</TabsTrigger>
              <TabsTrigger value="model">{t('usageByModel')}</TabsTrigger>
              <TabsTrigger value="provider">{t('usageByProvider')}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
            <TabsList>
              <TabsTrigger value="cost">{t('usageMetricCost')}</TabsTrigger>
              <TabsTrigger value="tokens">{t('usageMetricTokens')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {loading && !data && <p className="text-sm text-muted-foreground">{t('usageLoading')}</p>}
        {data && data.buckets.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('usageEmpty')}</p>
        )}
        {data && data.buckets.length > 0 && (
          <>
            {/* Keyed by dimension: the series it hides are that dimension's values */}
            <UsageChart
              key={dimension}
              series={legend}
              columns={columns}
              format={format}
              tickLabel={(c) => formatPeriod(c.start, granularity, data.timeZone, locale, 'short')}
              ariaLabel={t('usageChartLabel')}
              notes={{
                lifted: t('usageChartLifted'),
                legend: t('usageChartLegendHint'),
                excluded: t('usageChartExcluded'),
              }}
            />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(`usageBy${capitalize(dimension)}`)}</TableHead>
                  <TableHead className="text-right">{t('usageColCalls')}</TableHead>
                  <TableHead className="text-right">{t('usageColInput')}</TableHead>
                  <TableHead className="text-right">{t('usageColOutput')}</TableHead>
                  <TableHead className="text-right">{t('usageColCache')}</TableHead>
                  <TableHead className="text-right">{t('usageColCost')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>{label(row.key)}</TableCell>
                    <Numbers totals={row.totals} count={count} usd={usd} />
                  </TableRow>
                ))}
              </TableBody>
              {rows.length > 1 && (
                <TableFooter>
                  <TableRow>
                    <TableCell>{t('usageTotal')}</TableCell>
                    <Numbers totals={total} count={count} usd={usd} />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
            {unpriced > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('usageUnpriced', { count: unpriced })}
              </p>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">{t('usageNote')}</p>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** The bucket's own counts, summed */
type Totals = Pick<UsageBucket, (typeof TOTALLED)[number]>
const TOTALLED = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const

function Numbers({
  totals,
  count,
  usd,
}: {
  totals: Totals
  count: Intl.NumberFormat
  usd: (v: number) => string
}) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{count.format(totals.calls)}</TableCell>
      <TableCell className="text-right tabular-nums">{count.format(totals.inputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{count.format(totals.outputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {count.format(totals.cacheReadTokens + totals.cacheWriteTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{usd(totals.costUsd)}</TableCell>
    </>
  )
}

function measure(b: UsageBucket, metric: Metric): number {
  return metric === 'cost'
    ? b.costUsd
    : b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens
}

function emptyTotals(): Totals {
  return Object.fromEntries(TOTALLED.map((field) => [field, 0])) as Totals
}

function addTotals(a: Totals, b: Totals): Totals {
  return Object.fromEntries(TOTALLED.map((field) => [field, a[field] + b[field]])) as Totals
}

/**
 * The series to draw, in a fixed order so a colour stays with its entity:
 * purposes and providers in their declared order, models by name. Past five
 * models the smallest fold into one "other" — a sixth hue would not be told
 * apart.
 */
function seriesOf(buckets: UsageBucket[], dimension: Dimension): string[] {
  const present = new Set(buckets.map((b) => b[dimension]))
  if (dimension === 'purpose') return AI_USAGE_PURPOSES.filter((p) => present.has(p))
  if (dimension === 'provider') return AI_PROVIDERS.filter((p) => present.has(p))
  const models = [...present].sort()
  if (models.length <= SERIES_COLORS.length) return models
  const cost = new Map<string, number>()
  for (const b of buckets) cost.set(b.model, (cost.get(b.model) ?? 0) + b.costUsd)
  const kept = new Set(
    [...models].sort((a, b) => cost.get(b)! - cost.get(a)!).slice(0, SERIES_COLORS.length - 1)
  )
  return [...models.filter((m) => kept.has(m)), OTHER]
}

function groupKey(b: UsageBucket, dimension: Dimension, series: string[]): string {
  const key = b[dimension]
  return series.includes(key) ? key : OTHER
}

function totalsOf(buckets: UsageBucket[], dimension: Dimension, series: string[]) {
  const totals = new Map<string, Totals>(series.map((key) => [key, emptyTotals()]))
  for (const b of buckets) {
    const key = groupKey(b, dimension, series)
    totals.set(key, addTotals(totals.get(key) ?? emptyTotals(), b))
  }
  return series.map((key) => ({ key, totals: totals.get(key)! }))
}

/**
 * USD with cents, more digits below a dollar, and significant digits below a
 * cent — a query embedding costs a fraction of a millionth, and rounding it to
 * $0.00 would read as free.
 */
function usdFormatter(locale: string): (value: number) => string {
  const usd = (options: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', ...options })
  const cents = usd({})
  const fine = usd({ maximumFractionDigits: 4 })
  const tiny = usd({ maximumSignificantDigits: 2 })
  return (value) => {
    const size = Math.abs(value)
    if (size === 0 || size >= 1) return cents.format(value)
    return (size >= 0.01 ? fine : tiny).format(value)
  }
}

/** How a bucket's start reads: short under the axis, long in the tooltip */
const PERIOD_FORMATS: Record<Granularity, Record<'short' | 'long', Intl.DateTimeFormatOptions>> = {
  hour: { short: { hour: 'numeric' }, long: { month: 'numeric', day: 'numeric', hour: 'numeric' } },
  day: {
    short: { month: 'numeric', day: 'numeric' },
    long: { month: 'numeric', day: 'numeric', weekday: 'short' },
  },
  month: { short: { year: 'numeric', month: 'numeric' }, long: { year: 'numeric', month: 'long' } },
}

function formatPeriod(
  start: string,
  granularity: Granularity,
  timeZone: string,
  locale: string,
  length: 'short' | 'long'
): string {
  const options = PERIOD_FORMATS[granularity][length]
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(start))
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
