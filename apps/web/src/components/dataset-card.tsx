import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { FormatBadges } from './format-badges'

export interface DatasetCardItem {
  id: string
  name: string
  title?: string | null
  notes?: string | null
  formats?: string
  resourceCount?: number
  orgName?: string | null
  orgTitle?: string | null
}

export function DatasetCard({ pkg }: { pkg: DatasetCardItem }) {
  const t = useTranslations('dataset')
  return (
    <Link href={`/dataset/${pkg.name}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-lg">{pkg.title || pkg.name}</CardTitle>
            <div className="flex shrink-0 items-center gap-2">
              {typeof pkg.resourceCount === 'number' && (
                <span className="text-xs text-muted-foreground">
                  {t('resourceCount', { count: pkg.resourceCount })}
                </span>
              )}
              <FormatBadges formats={pkg.formats} />
            </div>
          </div>
          {pkg.orgName && (
            <p className="text-xs text-muted-foreground">{pkg.orgTitle || pkg.orgName}</p>
          )}
        </CardHeader>
        {pkg.notes && (
          <CardContent>
            <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.notes}</p>
          </CardContent>
        )}
      </Card>
    </Link>
  )
}
