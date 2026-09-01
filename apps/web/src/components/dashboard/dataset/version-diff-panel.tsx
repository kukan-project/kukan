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
import type { DiffRow, VersionDiffView } from '@kukan/shared'
import { useFetch } from '@/hooks/use-fetch'

/** How a cell reads, with `null` distinguished from an empty string. */
const cell = (value: unknown) => (value === null || value === undefined ? '—' : String(value))

/**
 * Compact preview of a few rows from one side of the diff.
 *
 * With `before`, the changed rows: each cell that moved is shown as what it
 * was and what it became. Showing only the new values says a row changed and
 * gives nothing to read that against, which is the one thing "changed" is
 * supposed to say.
 */
function SampleRows({
  rows,
  before,
  label,
}: {
  rows: DiffRow[]
  before?: DiffRow[]
  label: string
}) {
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
                {columns.map((col) => {
                  // Presence, not comparison: the older side is aligned by
                  // position and holds exactly the columns whose value moved.
                  // The values here are trimmed for display, so comparing them
                  // would call a cell that moved past the trim unmoved — and an
                  // absent column is either a key column or one that held
                  // still, both of which read once.
                  const was = before?.[i]?.[col]
                  const moved = before?.[i] !== undefined && col in before[i]
                  return (
                    <TableCell key={col} className="py-1">
                      {moved && (
                        <>
                          <span className="text-muted-foreground line-through">{cell(was)}</span>
                          <span className="text-muted-foreground mx-1">→</span>
                        </>
                      )}
                      {cell(row[col])}
                    </TableCell>
                  )
                })}
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
  const { data: diff, error } = useFetch<VersionDiffView>(
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
              <Badge key={`a-${c.name}`} variant="outline" wrap>
                + {c.name} ({c.type})
              </Badge>
            ))}
            {diff.schemaDiff.removed.map((c) => (
              <Badge key={`r-${c.name}`} variant="outline" wrap>
                − {c.name} ({c.type})
              </Badge>
            ))}
            {diff.schemaDiff.retyped.map((c) => (
              <Badge key={`t-${c.name}`} variant="outline" wrap>
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
            <SampleRows
              rows={diff.sampleChangedAfter}
              before={diff.sampleChangedBefore}
              label={t('diffSampleChanged')}
            />
          )}
        </>
      )}
    </div>
  )
}
