'use client'

import {
  Alert,
  AlertDescription,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { DiffUnavailableReason } from '@kukan/shared'
import { useFetch } from '@/hooks/use-fetch'

interface DiffColumn {
  name: string
  type: string
}

/** Mirrors VersionDiffService's VersionDiffView; the unions keep the shapes apart. */
type DiffView =
  | {
      available: false
      reason: DiffUnavailableReason
      from: number | null
      to: number
      /** Which of the two the reason is about, when it is about one of them.
       *  From the server: a version is as often blocked on the predecessor's
       *  side as on the opened one's, and the message names which. */
      reasonVersion: number | null
    }
  | ({ available: true; from: number; to: number } & (
      | {
          schemaChanged: true
          schemaDiff: {
            added: DiffColumn[]
            removed: DiffColumn[]
            retyped: { name: string; from: string; to: string }[]
          }
        }
      | {
          schemaChanged: false
          /**
           * Whether the rows were matched by a key. False means they were
           * compared whole, so an edit is one addition and one removal and
           * there is no count of edits to show — the absence is the point, not
           * a missing number (spec §7.1).
           */
          keyed: false
          addedRows: number
          removedRows: number
          sampleAdded: Record<string, unknown>[]
          sampleRemoved: Record<string, unknown>[]
        }
      | {
          schemaChanged: false
          keyed: true
          addedRows: number
          removedRows: number
          changedRows: number
          sampleAdded: Record<string, unknown>[]
          sampleRemoved: Record<string, unknown>[]
          /** The changed rows as the newer version holds them. */
          sampleChangedAfter: Record<string, unknown>[]
        }
    ))

/** Compact preview of a few rows from one side of the diff. */
function SampleRows({ rows, label }: { rows: Record<string, unknown>[]; label: string }) {
  if (rows.length === 0) return null
  const columns = Object.keys(rows[0])
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col} className="h-8 font-normal">
                  {col}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell key={col} className="py-1">
                    {row[col] === null ? '—' : String(row[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/**
 * Row-level diff against the preceding version (ADR-043 layer 2). Mounted only
 * while a version's diff is expanded, so the query runs on demand rather than
 * once per row when the history loads.
 */
export function VersionDiffPanel({ resourceId, version }: { resourceId: string; version: number }) {
  const t = useTranslations('resource.versions')
  const { data: diff, error } = useFetch<DiffView>(
    `/api/v1/resources/${resourceId}/versions/${version}/diff`
  )

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('diffError')}</AlertDescription>
      </Alert>
    )
  }
  if (!diff) return <p className="text-sm text-muted-foreground">{t('diffLoading')}</p>

  if (!diff.available) {
    return (
      <p className="text-sm text-muted-foreground">
        {/* A string, not the number: ICU groups digits, so v1000 would read
            "v1,000". Unused by the reasons that name no version. */}
        {t(`diffUnavailable.${diff.reason}`, { version: String(diff.reasonVersion ?? '') })}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {t('diffAgainst', { from: diff.from, to: diff.to })}
      </p>

      {diff.schemaChanged ? (
        <div className="flex flex-col gap-1">
          {/* Columns moved, so rows of the two versions are not comparable. */}
          <p className="text-sm">{t('diffSchemaChanged')}</p>
          <div className="flex flex-wrap gap-1">
            {diff.schemaDiff.added.map((c) => (
              <Badge key={`a-${c.name}`} variant="outline">
                + {c.name} ({c.type})
              </Badge>
            ))}
            {diff.schemaDiff.removed.map((c) => (
              <Badge key={`r-${c.name}`} variant="outline">
                − {c.name} ({c.type})
              </Badge>
            ))}
            {diff.schemaDiff.retyped.map((c) => (
              <Badge key={`t-${c.name}`} variant="outline">
                {c.name}: {c.from} → {c.to}
              </Badge>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t('diffAdded', { count: diff.addedRows })}</Badge>
            <Badge variant="outline">{t('diffRemoved', { count: diff.removedRows })}</Badge>
            {/* Only where rows were matched by a key. Without one an edit is an
                addition and a removal, and "changed 0" would read as "nothing
                was edited" rather than "this cannot be told" (spec §7.1). */}
            {diff.keyed && (
              <Badge variant="outline">{t('diffChanged', { count: diff.changedRows })}</Badge>
            )}
          </div>
          {diff.addedRows === 0 &&
            diff.removedRows === 0 &&
            (!diff.keyed || diff.changedRows === 0) && (
              <p className="text-sm text-muted-foreground">{t('diffNoRowChanges')}</p>
            )}
          <SampleRows rows={diff.sampleAdded} label={t('diffSampleAdded')} />
          <SampleRows rows={diff.sampleRemoved} label={t('diffSampleRemoved')} />
          {diff.keyed && (
            <SampleRows rows={diff.sampleChangedAfter} label={t('diffSampleChanged')} />
          )}
        </>
      )}
    </div>
  )
}
