'use client'

import { useTranslations } from 'next-intl'
import { showsAsTable, type ResourceSchema, type ResourceSummaryMeta } from '@kukan/shared'
import { DateTime } from '@/components/date-time'
import { ResourceAbstract } from '@/components/resource/resource-abstract'
import { formatBytes } from '@/lib/format-utils'

export interface ResourceInfoFields {
  id: string
  format?: string | null
  mimetype?: string | null
  size?: number | null
  hash?: string | null
  created?: string | null
  updated?: string | null
  lastModified?: string | null
  summary?: string | null
  summaryMeta?: ResourceSummaryMeta | null
}

/**
 * What the catalogue holds about a resource, read-only, under its editable
 * fields on the Basic tab: what the file is, when it moved, and the AI-written
 * description the public page shows (ADR-053), with the same notices. A
 * description hidden from readers is not shown here either.
 *
 * `schema` is the editor's read of it, which follows a run settling: rows and
 * columns are a run's products.
 */
export function ResourceInfo({
  resource,
  latestVersion,
  schema: read,
}: {
  resource: ResourceInfoFields
  latestVersion?: number | null
  schema?: ResourceSchema | null
}) {
  const t = useTranslations('datasetEditor')
  const tr = useTranslations('resource')
  // A workbook not read as a table lists what any document does
  const schema = read && showsAsTable(resource.format, resource.mimetype, read) ? read : null

  const rows: [string, React.ReactNode][] = [
    [tr('mimeType'), resource.mimetype],
    [tr('size'), formatBytes(resource.size)],
    [tr('hash'), resource.hash ? <span className="font-mono text-xs">{resource.hash}</span> : null],
    [t('currentVersion'), latestVersion ? `v${latestVersion}` : null],
    [t('rowCount'), schema ? schema.rowCount.toLocaleString() : null],
    [t('columnCount'), schema ? schema.columns.length.toLocaleString() : null],
    [tr('createdShort'), resource.created ? <DateTime value={resource.created} /> : null],
    [tr('updatedShort'), resource.updated ? <DateTime value={resource.updated} /> : null],
    [tr('lastModified'), resource.lastModified ? <DateTime value={resource.lastModified} /> : null],
  ]

  return (
    // The description beside the list rather than inside it: it carries a
    // heading of its own, at the same level
    <>
      <section
        className="flex flex-col gap-4 border-t pt-4"
        aria-labelledby="resource-info-heading"
      >
        <h2 id="resource-info-heading" className="text-sm font-semibold">
          {t('infoHeading')}
        </h2>
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-all">{value}</dd>
              </div>
            ))}
        </dl>
      </section>
      <ResourceAbstract
        summary={resource.summary}
        summaryMeta={resource.summaryMeta}
        latestVersion={latestVersion}
      />
    </>
  )
}
