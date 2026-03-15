import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@kukan/ui'
import type { FacetCounts, FacetItem } from '@kukan/shared'
import { buildQuery } from '@/lib/query'

interface DatasetFiltersProps {
  query: string
  currentOrg?: string
  currentGroup?: string
  currentTags: string[]
  currentFormat?: string
  currentLicense?: string
  facets: FacetCounts
}

type FilterParams = Record<string, string | undefined>

function buildDatasetUrl(params: FilterParams) {
  return `/dataset?${buildQuery(params)}`
}

function toggleTag(currentTags: string[], tag: string): string {
  const set = new Set(currentTags)
  if (set.has(tag)) set.delete(tag)
  else set.add(tag)
  return [...set].join(',')
}

function FilterSection({
  title,
  defaultOpen,
  clearHref,
  clearLabel,
  children,
}: {
  title: string
  defaultOpen?: boolean
  clearHref?: string
  clearLabel?: string
  children: React.ReactNode
}) {
  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          {title}
          {clearHref && (
            <>
              <span className="h-2 w-2 rounded-full bg-primary" />
              <Link
                href={clearHref}
                className="rounded border border-input bg-background px-1.5 py-0.5 text-xs font-normal text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
              >
                {clearLabel}
              </Link>
            </>
          )}
        </span>
        <svg
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

function FilterList({
  items,
  activeValue,
  buildHref,
  displayName,
  className,
}: {
  items: FacetItem[]
  activeValue?: string
  buildHref: (name: string) => string
  displayName?: (item: FacetItem) => string
  className?: string
}) {
  const baseClass = `flex items-center justify-between rounded-md px-2 py-1 text-sm${className ? ` ${className}` : ''}`
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const isActive = activeValue === item.name
        const label = displayName ? displayName(item) : item.title || item.name
        const content = (
          <>
            <span className="truncate">{label}</span>
            <span className="ml-2 shrink-0 tabular-nums text-xs text-muted-foreground">
              {item.count}
            </span>
          </>
        )
        if (item.count === 0 && !isActive) {
          return (
            <li key={item.name}>
              <span className={`${baseClass} cursor-default text-muted-foreground/50`}>
                {content}
              </span>
            </li>
          )
        }
        return (
          <li key={item.name}>
            <Link
              href={buildHref(item.name)}
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
  )
}

export function DatasetFilters({
  query,
  currentOrg,
  currentGroup,
  currentTags,
  currentFormat,
  currentLicense,
  facets,
}: DatasetFiltersProps) {
  const t = useTranslations('search')

  const baseParams: FilterParams = {
    q: query || undefined,
    owner_org: currentOrg,
    group: currentGroup,
    tags: currentTags.join(',') || undefined,
    formats: currentFormat,
    license_id: currentLicense,
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Organization filter */}
      <FilterSection
        title={t('filterByOrganization')}
        defaultOpen={!!currentOrg}
        clearHref={
          currentOrg ? buildDatasetUrl({ ...baseParams, owner_org: undefined }) : undefined
        }
        clearLabel={t('clear')}
      >
        <FilterList
          items={facets.organizations}
          activeValue={currentOrg}
          buildHref={(name) => buildDatasetUrl({ ...baseParams, owner_org: name })}
        />
      </FilterSection>

      {/* Group filter */}
      {facets.groups.length > 0 && (
        <FilterSection
          title={t('filterByGroup')}
          defaultOpen={!!currentGroup}
          clearHref={
            currentGroup ? buildDatasetUrl({ ...baseParams, group: undefined }) : undefined
          }
          clearLabel={t('clear')}
        >
          <FilterList
            items={facets.groups}
            activeValue={currentGroup}
            buildHref={(name) => buildDatasetUrl({ ...baseParams, group: name })}
          />
        </FilterSection>
      )}

      {/* Tag filter */}
      {facets.tags.length > 0 && (
        <FilterSection
          title={t('filterByTag')}
          defaultOpen={currentTags.length > 0}
          clearHref={
            currentTags.length > 0 ? buildDatasetUrl({ ...baseParams, tags: undefined }) : undefined
          }
          clearLabel={t('clear')}
        >
          <div className="flex flex-wrap gap-1">
            {facets.tags.map((tag) => {
              const isSelected = currentTags.includes(tag.name)
              if (tag.count === 0 && !isSelected) {
                return (
                  <span key={tag.name} className="opacity-40">
                    <Badge variant="secondary" className="cursor-default">
                      {tag.name}
                      <span className="ml-1 text-xs opacity-70">{tag.count}</span>
                    </Badge>
                  </span>
                )
              }
              const newTags = toggleTag(currentTags, tag.name)
              return (
                <Link
                  key={tag.name}
                  href={buildDatasetUrl({ ...baseParams, tags: newTags || undefined })}
                >
                  <Badge variant={isSelected ? 'default' : 'secondary'} className="cursor-pointer">
                    {tag.name}
                    <span className="ml-1 text-xs opacity-70">{tag.count}</span>
                  </Badge>
                </Link>
              )
            })}
          </div>
        </FilterSection>
      )}

      {/* Format filter */}
      {facets.formats.length > 0 && (
        <FilterSection
          title={t('filterByFormat')}
          defaultOpen={!!currentFormat}
          clearHref={
            currentFormat ? buildDatasetUrl({ ...baseParams, formats: undefined }) : undefined
          }
          clearLabel={t('clear')}
        >
          <FilterList
            items={facets.formats}
            activeValue={currentFormat}
            buildHref={(name) => buildDatasetUrl({ ...baseParams, formats: name })}
            className="font-mono uppercase"
          />
        </FilterSection>
      )}

      {/* License filter */}
      {facets.licenses.length > 0 && (
        <FilterSection
          title={t('filterByLicense')}
          defaultOpen={!!currentLicense}
          clearHref={
            currentLicense ? buildDatasetUrl({ ...baseParams, license_id: undefined }) : undefined
          }
          clearLabel={t('clear')}
        >
          <FilterList
            items={facets.licenses}
            activeValue={currentLicense}
            buildHref={(name) => buildDatasetUrl({ ...baseParams, license_id: name })}
          />
        </FilterSection>
      )}
    </div>
  )
}
