'use client'

import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useParquetSchema, type FieldType } from '@/hooks/use-parquet-schema'
import { formatBytes } from '@/lib/format-utils'

interface ResourceFieldsProps {
  resourceId: string
}

const FIELD_TYPE_KEY: Record<FieldType, string> = {
  string: 'fieldTypeString',
  integer: 'fieldTypeInteger',
  number: 'fieldTypeNumber',
  boolean: 'fieldTypeBoolean',
  date: 'fieldTypeDate',
  datetime: 'fieldTypeDatetime',
}

/**
 * Lists the field (column) names of a tabular resource, read from the generated
 * Parquet schema. Renders nothing when no Parquet preview exists (e.g. oversize
 * CSV or a resource not yet processed), so it is safe to mount for any CSV/TSV.
 */
export function ResourceFields({ resourceId }: ResourceFieldsProps) {
  const t = useTranslations('resource')
  const { fields, loading, error } = useParquetSchema(resourceId)

  // No schema (not a Parquet resource), still loading, or read error: hide entirely.
  // The footer read is cheap, so we omit a skeleton to avoid a flash-then-disappear
  // for resources without a Parquet preview.
  if (loading || error || !fields?.length) return null

  return (
    <details className="group" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">&#9654;</span>
        {t('fields')}
        <span className="text-xs font-normal">{t('fieldsCount', { count: fields.length })}</span>
      </summary>
      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="border-b bg-muted">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                {t('fieldName')}
              </th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                {t('fieldType')}
              </th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                {t('fieldPhysicalType')}
              </th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                {t('fieldLogicalType')}
              </th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                {t('fieldNullable')}
              </th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                {t('fieldSize')}
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, i) => (
              <tr key={i} className="border-b last:border-b-0">
                <td className="px-4 py-2 font-medium">{field.name}</td>
                <td className="px-4 py-2">
                  <Badge variant="secondary">{t(FIELD_TYPE_KEY[field.type])}</Badge>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{field.physicalType ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{field.logicalType ?? '—'}</td>
                <td className="px-4 py-2">
                  <Badge variant={field.nullable ? 'outline' : 'default'}>
                    {field.nullable ? t('fieldNullableYes') : t('fieldNullableNo')}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatBytes(field.compressedSize)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
