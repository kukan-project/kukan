import { getTranslations } from 'next-intl/server'
import { resolveLicenseLabel } from '@kukan/shared'
import { DateTime } from '@/components/date-time'
import { KeyValueTable, extrasToRows } from '@/components/key-value-table'

interface MetadataPackage {
  maintainer?: string | null
  author?: string | null
  licenseId?: string | null
  version?: string | null
  url?: string | null
  created: string
  updated: string
  extras?: Record<string, unknown> | null
}

export async function DatasetMetadata({ pkg }: { pkg: MetadataPackage }) {
  const [t, tl] = await Promise.all([getTranslations('dataset'), getTranslations('license')])

  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">&#9654;</span>
        {t('additionalInfo')}
      </summary>
      <div className="mt-4">
        <KeyValueTable
          rows={[
            { label: t('maintainer'), value: pkg.maintainer },
            { label: t('author'), value: pkg.author },
            { label: t('license'), value: pkg.licenseId ? resolveLicenseLabel(pkg.licenseId, tl) : null },
            { label: t('version'), value: pkg.version },
            { label: t('created'), value: <DateTime value={pkg.created} /> },
            { label: t('updated'), value: <DateTime value={pkg.updated} /> },
            {
              label: t('sourceUrl'),
              value: pkg.url ? (
                <a
                  href={pkg.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-primary underline-offset-4 hover:underline"
                >
                  {pkg.url}
                </a>
              ) : null,
            },
            ...extrasToRows(pkg.extras),
          ]}
        />
      </div>
    </details>
  )
}
