'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Building2, Calendar, FileText, FolderOpen, Search, Sparkles, Tag } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { FormatBadge } from './format-badge'
import { FormatBadges } from './format-badges'
import { CompactDate } from './date-time'
import { parseGroups } from '@/lib/parse-groups'
import type { MatchedResource } from '@kukan/search-adapter'

/** Tailwind classes for search term highlighting */
const HIGHLIGHT_MARK =
  '[&>mark]:rounded-sm [&>mark]:bg-highlight/60 [&>mark]:px-0.5 [&>mark+mark]:pl-0 [&>mark+mark]:rounded-l-none [&>mark:has(+mark)]:pr-0 [&>mark:has(+mark)]:rounded-r-none'

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
  highlightedTitle?: string
  highlightedNotes?: string
  matchSource?: 'semantic'
}

export function DatasetCard({ pkg }: { pkg: DatasetCardItem }) {
  const t = useTranslations('dataset')
  const datasetHref = `/dataset/${pkg.name}`
  return (
    <article className="relative">
      <Card className="transition-colors hover:bg-accent/50">
        {/* Stacked rows need more air than the wrap gap inside each row (gap-y-1) */}
        <CardHeader className="gap-3 sm:gap-2">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-2">
            <CardTitle className="min-w-0 text-lg sm:flex-1">
              <Link
                href={datasetHref}
                className={`after:absolute after:inset-0 after:content-[''] ${HIGHLIGHT_MARK}`}
                {...(pkg.highlightedTitle
                  ? { dangerouslySetInnerHTML: { __html: pkg.highlightedTitle } }
                  : { children: pkg.title || pkg.name })}
              />
            </CardTitle>
            {pkg.matchSource === 'semantic' && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-primary/30 text-xs font-normal text-primary"
              >
                <Sparkles className="h-3 w-3" />
                {t('semanticMatch')}
              </Badge>
            )}
            {(pkg.updated || pkg.created) && (
              <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
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
          {(pkg.title || typeof pkg.resourceCount === 'number' || pkg.formats) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {pkg.title && <span className="break-all font-mono">{pkg.name}</span>}
              {(typeof pkg.resourceCount === 'number' || pkg.formats) && (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  {typeof pkg.resourceCount === 'number' && (
                    <span className="shrink-0">
                      {t('resourceCount', { count: pkg.resourceCount })}
                    </span>
                  )}
                  <FormatBadges formats={pkg.formats} />
                </div>
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
                  <Badge key={tagName} variant="secondary" wrap className="text-xs">
                    <Tag className="mr-0.5 h-3 w-3" />
                    {tagName}
                  </Badge>
                ))}
            </div>
          )}
        </CardHeader>
        {(pkg.notes ||
          pkg.highlightedNotes ||
          (pkg.matchedResources && pkg.matchedResources.length > 0)) && (
          <CardContent className="space-y-3">
            {(pkg.notes || pkg.highlightedNotes) &&
              (pkg.highlightedNotes ? (
                <p
                  className={`line-clamp-2 text-sm text-muted-foreground ${HIGHLIGHT_MARK}`}
                  dangerouslySetInnerHTML={{ __html: pkg.highlightedNotes }}
                />
              ) : (
                <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.notes}</p>
              ))}
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
                          {r.highlightedName ? (
                            <span
                              className={`truncate font-medium group-hover/resource:underline ${HIGHLIGHT_MARK}`}
                              dangerouslySetInnerHTML={{ __html: r.highlightedName }}
                            />
                          ) : (
                            <span className="truncate font-medium group-hover/resource:underline">
                              {r.name || r.id}
                            </span>
                          )}
                          {r.format && <FormatBadge format={r.format} className="shrink-0" />}
                        </div>
                        {(r.description || r.highlightedDescription) &&
                          (r.highlightedDescription ? (
                            <p
                              className={`line-clamp-1 text-xs text-muted-foreground ${HIGHLIGHT_MARK}`}
                              dangerouslySetInnerHTML={{ __html: r.highlightedDescription }}
                            />
                          ) : (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              {r.description}
                            </p>
                          ))}
                        {r.matchSource === 'content' && (
                          <div className="mt-1 space-y-1">
                            <span className="flex items-center gap-0.5 text-[10px] font-medium text-primary">
                              <Search className="h-2.5 w-2.5" />
                              {t('contentMatch')}
                            </span>
                            {r.contentSnippets && r.contentSnippets.length > 0 ? (
                              r.contentSnippets.map((snippet, i) => (
                                // line-clamp clips at the padding box, so padding lives on the wrapper
                                <div
                                  key={i}
                                  className="rounded border border-primary/20 bg-primary/5 px-2 py-1.5"
                                >
                                  <p
                                    className={`line-clamp-4 text-xs break-words text-muted-foreground ${HIGHLIGHT_MARK}`}
                                    suppressHydrationWarning
                                    dangerouslySetInnerHTML={{
                                      __html: snippet.replace(/\n/g, ' '),
                                    }}
                                  />
                                </div>
                              ))
                            ) : (
                              <div className="flex h-7 w-full items-center gap-2 rounded border border-primary/10 bg-primary/5 px-2">
                                <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary/20 border-t-primary/60" />
                                <span className="text-[10px] text-muted-foreground">
                                  {t('loadingSnippet')}
                                </span>
                              </div>
                            )}
                          </div>
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
