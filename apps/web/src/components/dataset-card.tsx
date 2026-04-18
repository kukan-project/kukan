'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Building2, Calendar, FileText, FolderOpen, Search, Tag } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { FormatBadge } from './format-badge'
import { FormatBadges } from './format-badges'
import { CompactDate } from './date-time'
import { parseGroups } from '@/lib/parse-groups'
import type { MatchedResource } from '@kukan/search-adapter'

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
  created?: string
  updated?: string
  matchedResources?: MatchedResource[]
}

export function DatasetCard({ pkg }: { pkg: DatasetCardItem }) {
  const t = useTranslations('dataset')
  const datasetHref = `/dataset/${pkg.name}`
  return (
    <article className="relative">
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-lg">
                <Link
                  href={datasetHref}
                  className="after:absolute after:inset-0 after:content-['']"
                >
                  {pkg.title || pkg.name}
                </Link>
              </CardTitle>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {typeof pkg.resourceCount === 'number' && (
                <span className="text-xs text-muted-foreground">
                  {t('resourceCount', { count: pkg.resourceCount })}
                </span>
              )}
              <FormatBadges formats={pkg.formats} />
            </div>
          </div>
          {(pkg.title || pkg.updated || pkg.created) && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              {pkg.title ? <span className="font-mono">{pkg.name}</span> : <span />}
              {(pkg.updated || pkg.created) && (
                <span className="flex shrink-0 items-center gap-3">
                  <Calendar className="h-3 w-3" />
                  {pkg.updated && (
                    <span>
                      {t('updatedShort')}: <CompactDate value={pkg.updated} />
                    </span>
                  )}
                  {pkg.created && (
                    <span>
                      {t('createdShort')}: <CompactDate value={pkg.created} />
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
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
        {(pkg.notes || (pkg.matchedResources && pkg.matchedResources.length > 0)) && (
          <CardContent className="space-y-3">
            {pkg.notes && <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.notes}</p>}
            {pkg.matchedResources && pkg.matchedResources.length > 0 && (
              <div className="relative z-10">
                <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  {t('matchedResources')}
                </p>
                <ul className="space-y-1.5 border-l-2 border-muted-foreground/20 pl-3">
                  {pkg.matchedResources.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/dataset/${pkg.name}/resource/${r.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="group/resource block rounded-sm hover:bg-accent/50"
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="truncate font-medium group-hover/resource:underline">
                            {r.name || r.id}
                          </span>
                          {r.format && <FormatBadge format={r.format} className="shrink-0" />}
                        </div>
                        {r.matchSource === 'content' && r.contentSnippet && (
                          <p
                            className="line-clamp-2 text-xs text-muted-foreground"
                            dangerouslySetInnerHTML={{ __html: r.contentSnippet }}
                          />
                        )}
                        {r.matchSource === 'content' && (
                          <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-primary">
                            <Search className="h-2.5 w-2.5" />
                            {t('contentMatch')}
                          </span>
                        )}
                        {r.matchSource !== 'content' && r.description && (
                          <p className="line-clamp-1 text-xs text-muted-foreground">
                            {r.description}
                          </p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </article>
  )
}
