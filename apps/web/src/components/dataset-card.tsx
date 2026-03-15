import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Building2, FolderOpen, Tag } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
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
  tags?: string
  groups?: string
}

function parseGroups(groups?: string): { name: string; title: string }[] {
  if (!groups) return []
  return groups.split(',').map((g) => {
    const [name, ...rest] = g.split(':')
    return { name, title: rest.join(':') || name }
  })
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
          {(pkg.orgName || pkg.groups || pkg.tags) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {pkg.orgName && (
                <span className="flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5" />
                  {pkg.orgTitle || pkg.orgName}
                </span>
              )}
              {pkg.groups &&
                parseGroups(pkg.groups).map((g) => (
                  <span key={g.name} className="flex items-center gap-1">
                    <FolderOpen className="h-3.5 w-3.5" />
                    {g.title}
                  </span>
                ))}
              {pkg.tags &&
                pkg.tags.split(',').map((tagName) => (
                  <Badge key={tagName} variant="secondary" className="text-xs">
                    <Tag className="mr-0.5 h-3 w-3" />
                    {tagName}
                  </Badge>
                ))}
            </div>
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
