'use client'

import { useMemo, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import { useLocale, useTranslations } from 'next-intl'
import {
  typeReviewChoicesFor,
  type ReadType,
  type ResourceColumn,
  type TypeChange,
  type TypeReviewChoice,
  type VersionView,
} from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { columnTypeKey } from '@/lib/format-utils'
import { useSettledEstimateState, type ColumnEstimate } from '@/hooks/use-settled-estimate'

/** Choices that change how the column reads, and so make a version (§8.4) */
const MAKES_VERSION: readonly TypeReviewChoice[] = ['settle-previous', 'lift']
/** Samples of values not converted shown per column; the version keeps ten */
const SAMPLES = 3
/** A stable empty schema, so the estimate reads nothing where it is not asked for */
const NO_COLUMNS: ResourceColumn[] = []

/**
 * What a version's reading needs a person to look at, and their choice for
 * each column (Versioning ii-c §8.4): accept it as read, settle the type the
 * version before read, or lift a settled type. The two that change the reading
 * make a version, so they are offered on the current version only — the server
 * refuses them on another (409), and this says so before it is asked.
 */
export function TypeReviewPanel({
  resourceId,
  version,
  current,
  onReviewed,
}: {
  resourceId: string
  version: VersionView
  /** Whether it is the newest version, the one a choice that makes a version may be made on */
  current: boolean
  /** Where a person may review; without it, the panel only shows what changed */
  onReviewed?: () => void
}) {
  const t = useTranslations('resource.versions')
  const changes = version.typeChanges ?? []
  const columns = [...new Set(changes.map((change) => change.column))]
  const [choices, setChoices] = useState<Record<string, TypeReviewChoice>>(() =>
    Object.fromEntries(columns.map((column) => [column, 'accept' as const]))
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewable = onReviewed && !version.reviewedAt
  const makesVersion = Object.values(choices).some((choice) => MAKES_VERSION.includes(choice))

  // What settling the previous type would leave without a value, off the
  // preview — this version's, as only the current one may be settled — with
  // the rules the version will be read by: said before it is chosen, not
  // found in the version it makes
  const estimating = !!reviewable && current
  const settling = useMemo(
    () =>
      Object.fromEntries(
        changes.flatMap((change) =>
          estimating &&
          change.kind === 'type' &&
          choices[change.column] === 'settle-previous' &&
          // Only a column the schema has can be estimated, and waited on
          !!version.schema?.columns.some((c) => c.name === change.column)
            ? [[change.column, change.from.type]]
            : []
        )
      ),
    [changes, choices, estimating, version.schema]
  )
  const { estimate, failed: estimateFailed } = useSettledEstimateState({
    resourceId,
    types: settling,
    columns: estimating ? (version.schema?.columns ?? NO_COLUMNS) : NO_COLUMNS,
    rowCount: version.schema?.rowCount ?? 0,
  })
  // Confirmed only once what settling leaves out has been said — or could not be
  const unestimated = Object.keys(settling).some((column) => !estimate?.columns[column])
  const waiting = unestimated && !estimateFailed

  const typeName = useTypeName()
  /** A choice, with the type it leaves the column read as where that is known */
  function choiceLabel(column: string, choice: TypeReviewChoice): string {
    const retyped = changes.find((change) => change.column === column && change.kind === 'type')
    const read = version.schema?.columns.find((c) => c.name === column)
    switch (choice) {
      case 'accept': {
        const now = retyped?.kind === 'type' ? retyped.to : read
        return now ? t('reviewChoiceAcceptAs', { type: typeName(now) }) : t('reviewChoice.accept')
      }
      case 'settle-previous':
        return retyped?.kind === 'type'
          ? t('reviewChoiceSettleTo', { type: typeName(retyped.from) })
          : t('reviewChoice.settle-previous')
      case 'lift':
        return read?.inferredType
          ? t('reviewChoiceLiftTo', { type: typeName({ type: read.inferredType }) })
          : t('reviewChoice.lift')
    }
  }

  async function submit() {
    setSending(true)
    setError(null)
    try {
      const res = await clientFetch(
        `/api/v1/resources/${resourceId}/versions/${version.version}/type-review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ choices }),
        }
      )
      if (res.status === 409) {
        // A newer version, or another person's review: the list read again says which
        setError(t('reviewConflict'))
        onReviewed?.()
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      onReviewed?.()
    } catch {
      setError(t('reviewError'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {version.reviewedAt
          ? t('reviewDone', { at: new Date(version.reviewedAt).toLocaleString() })
          : t('reviewIntro')}
      </p>
      <ul className="flex flex-col gap-3">
        {columns.map((column) => (
          <li key={column} className="flex flex-col gap-1">
            <span className="font-medium [overflow-wrap:anywhere]">{column}</span>
            {changes
              .filter((change) => change.column === column)
              .map((change) => (
                <span key={change.kind}>
                  <ChangeLine change={change} version={version} />
                </span>
              ))}
            {reviewable && (
              <Select
                value={choices[column]}
                onValueChange={(value) =>
                  setChoices((prev) => ({ ...prev, [column]: value as TypeReviewChoice }))
                }
              >
                <SelectTrigger
                  className="h-8 w-fit gap-1 py-1"
                  aria-label={t('reviewChoiceFor', { column })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeReviewChoicesFor(changes, column).map((choice) => (
                    <SelectItem
                      key={choice}
                      value={choice}
                      disabled={!current && MAKES_VERSION.includes(choice)}
                    >
                      {choiceLabel(column, choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {estimate?.columns[column] && settling[column] && (
              <SettleEstimate
                column={estimate.columns[column]}
                rows={estimate.rows}
                whole={estimate.whole}
              />
            )}
          </li>
        ))}
      </ul>
      {reviewable && (
        <>
          {!current && <p className="text-muted-foreground text-xs">{t('reviewNotCurrent')}</p>}
          {makesVersion && (
            <p className="text-muted-foreground text-xs">{t('reviewMakesVersion')}</p>
          )}
          {waiting && <p className="text-muted-foreground text-xs">{t('settleEstimating')}</p>}
          {unestimated && estimateFailed && (
            <p className="text-muted-foreground text-xs">{t('settleEstimateFailed')}</p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button size="sm" onClick={submit} disabled={sending || waiting}>
              {t('reviewSubmit')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/** A type as a person reads it, with a decimal's digits. */
function useTypeName() {
  const t = useTranslations('resource.versions')
  const tr = useTranslations('resource')
  return (read: ReadType) =>
    read.type === 'decimal' && read.decimalPrecision !== undefined
      ? t('reviewDecimal', {
          precision: String(read.decimalPrecision),
          scale: String(read.decimalScale ?? 0),
        })
      : tr(columnTypeKey(read.type))
}

/** What settling the previous type would make of the column's values. */
function SettleEstimate({
  column,
  rows,
  whole,
}: {
  column: ColumnEstimate
  rows: number
  /** Whether the rows read are all the table has */
  whole: boolean
}) {
  const t = useTranslations('resource.versions')
  const locale = useLocale()
  const failures = column.castFailures ?? 0
  const count = new Intl.NumberFormat(locale)
  const numbers = {
    rows: count.format(rows),
    count: count.format(failures),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
      rows > 0 ? failures / rows : 0
    ),
  }
  if (column.dateFormatUndecided) {
    return <span className="text-muted-foreground text-xs">{t('settleUndecided')}</span>
  }
  return failures > 0 ? (
    <span
      className="text-xs"
      title={column.castFailureSamples
        ?.map((sample) => t('reviewSample', { row: String(sample.row), value: sample.value }))
        .join('\n')}
    >
      {t(whole ? 'settleFailuresWhole' : 'settleFailures', numbers)}
    </span>
  ) : (
    <span className="text-muted-foreground text-xs">
      {t(whole ? 'settleReadsWhole' : 'settleReads', numbers)}
    </span>
  )
}

/** One change, as a person reads it. */
function ChangeLine({ change, version }: { change: TypeChange; version: VersionView }) {
  const t = useTranslations('resource.versions')
  const typeName = useTypeName()
  switch (change.kind) {
    case 'type':
      return <>{t('reviewTypeChanged', { from: typeName(change.from), to: typeName(change.to) })}</>
    case 'cast-failures': {
      const samples = version.schema?.columns.find(
        (column) => column.name === change.column
      )?.castFailureSamples
      return (
        <>
          {t('reviewCastFailures', { count: change.count })}
          {samples && samples.length > 0 && (
            <span className="text-muted-foreground block text-xs [overflow-wrap:anywhere]">
              {samples
                .slice(0, SAMPLES)
                .map((sample) =>
                  t('reviewSample', { row: String(sample.row), value: sample.value })
                )
                .join(' / ')}
            </span>
          )}
        </>
      )
    }
    case 'missing':
      return <>{t('reviewMissing')}</>
    case 'date-undecided':
      return <>{t('reviewDateUndecided')}</>
  }
}
