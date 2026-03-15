import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@kukan/ui'
import type { FacetCounts } from '@kukan/shared'
import { buildQuery } from '@/lib/query'

interface DatasetFiltersProps {
  query: string
  currentOrg?: string
  currentGroup?: string
  currentTags: string[]
  currentFormat?: string
  facets: FacetCounts
}

function buildDatasetUrl(params: {
  q?: string
  owner_org?: string
  group?: string
  tags?: string
  formats?: string
}) {
  return `/dataset?${buildQuery({ q: params.q, owner_org: params.owner_org, group: params.group, tags: params.tags, formats: params.formats })}`
}

function toggleTag(currentTags: string[], tag: string): string {
  const set = new Set(currentTags)
  if (set.has(tag)) set.delete(tag)
  else set.add(tag)
  return [...set].join(',')
}

export function DatasetFilters({
  query,
  currentOrg,
  currentGroup,
  currentTags,
  currentFormat,
  facets,
}: DatasetFiltersProps) {
  const t = useTranslations('search')

  const baseParams = {
    q: query || undefined,
    owner_org: currentOrg,
    group: currentGroup,
    tags: currentTags.join(',') || undefined,
    formats: currentFormat,
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Organization filter */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('filterByOrganization')}</h3>
        <ul className="flex flex-col gap-1">
          <li>
            <Link
              href={buildDatasetUrl({ ...baseParams, owner_org: undefined })}
              className={`block rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent ${
                !currentOrg ? 'bg-accent font-medium' : 'text-muted-foreground'
              }`}
            >
              {t('allOrganizations')}
            </Link>
          </li>
          {facets.organizations.map((org) => {
            const isActive = currentOrg === org.name
            const content = (
              <>
                <span className="truncate">{org.title || org.name}</span>
                <span className="ml-2 shrink-0 tabular-nums text-xs text-muted-foreground">
                  {org.count}
                </span>
              </>
            )
            const baseClass = 'flex items-center justify-between rounded-md px-2 py-1 text-sm'
            if (org.count === 0 && !isActive) {
              return (
                <li key={org.name}>
                  <span className={`${baseClass} cursor-default text-muted-foreground/50`}>
                    {content}
                  </span>
                </li>
              )
            }
            return (
              <li key={org.name}>
                <Link
                  href={buildDatasetUrl({ ...baseParams, owner_org: org.name })}
                  className={`${baseClass} transition-colors hover:bg-accent ${
                    isActive ? 'bg-accent font-medium' : 'text-muted-foreground'
                  }`}
                >
                  {content}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Group filter */}
      {facets.groups.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('filterByGroup')}</h3>
          <ul className="flex flex-col gap-1">
            <li>
              <Link
                href={buildDatasetUrl({ ...baseParams, group: undefined })}
                className={`block rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent ${
                  !currentGroup ? 'bg-accent font-medium' : 'text-muted-foreground'
                }`}
              >
                {t('allGroups')}
              </Link>
            </li>
            {facets.groups.map((g) => {
              const isActive = currentGroup === g.name
              const content = (
                <>
                  <span className="truncate">{g.title || g.name}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-xs text-muted-foreground">
                    {g.count}
                  </span>
                </>
              )
              const baseClass = 'flex items-center justify-between rounded-md px-2 py-1 text-sm'
              if (g.count === 0 && !isActive) {
                return (
                  <li key={g.name}>
                    <span className={`${baseClass} cursor-default text-muted-foreground/50`}>
                      {content}
                    </span>
                  </li>
                )
              }
              return (
                <li key={g.name}>
                  <Link
                    href={buildDatasetUrl({ ...baseParams, group: g.name })}
                    className={`${baseClass} transition-colors hover:bg-accent ${
                      isActive ? 'bg-accent font-medium' : 'text-muted-foreground'
                    }`}
                  >
                    {content}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Tag filter */}
      {facets.tags.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('filterByTag')}</h3>
          <div className="flex flex-wrap gap-1">
            {facets.tags.map((t) => {
              const isSelected = currentTags.includes(t.name)
              if (t.count === 0 && !isSelected) {
                return (
                  <span key={t.name} className="opacity-40">
                    <Badge variant="secondary" className="cursor-default">
                      {t.name}
                      <span className="ml-1 text-xs opacity-70">{t.count}</span>
                    </Badge>
                  </span>
                )
              }
              const newTags = toggleTag(currentTags, t.name)
              return (
                <Link
                  key={t.name}
                  href={buildDatasetUrl({ ...baseParams, tags: newTags || undefined })}
                >
                  <Badge variant={isSelected ? 'default' : 'secondary'} className="cursor-pointer">
                    {t.name}
                    <span className="ml-1 text-xs opacity-70">{t.count}</span>
                  </Badge>
                </Link>
              )
            })}
          </div>
          {currentTags.length > 0 && (
            <Link
              href={buildDatasetUrl({ ...baseParams, tags: undefined })}
              className="text-xs text-muted-foreground hover:underline"
            >
              {t('clearTags')}
            </Link>
          )}
        </div>
      )}

      {/* Format filter */}
      {facets.formats.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('filterByFormat')}</h3>
          <ul className="flex flex-col gap-1">
            <li>
              <Link
                href={buildDatasetUrl({ ...baseParams, formats: undefined })}
                className={`block rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent ${
                  !currentFormat ? 'bg-accent font-medium' : 'text-muted-foreground'
                }`}
              >
                {t('allFormats')}
              </Link>
            </li>
            {facets.formats.map((f) => {
              const isActive = currentFormat === f.name
              const content = (
                <>
                  <span>{f.name}</span>
                  <span className="ml-2 shrink-0 font-sans tabular-nums text-xs text-muted-foreground">
                    {f.count}
                  </span>
                </>
              )
              const baseClass =
                'flex items-center justify-between rounded-md px-2 py-1 text-sm font-mono uppercase'
              if (f.count === 0 && !isActive) {
                return (
                  <li key={f.name}>
                    <span className={`${baseClass} cursor-default text-muted-foreground/50`}>
                      {content}
                    </span>
                  </li>
                )
              }
              return (
                <li key={f.name}>
                  <Link
                    href={buildDatasetUrl({ ...baseParams, formats: f.name })}
                    className={`${baseClass} transition-colors hover:bg-accent ${
                      isActive ? 'bg-accent font-medium' : 'text-muted-foreground'
                    }`}
                  >
                    {content}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
