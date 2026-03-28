import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Building2, FolderOpen, Tag, FileText, Scale, ChevronDown } from 'lucide-react'
import { Badge } from '@kukan/ui'
import type { FacetCounts, FacetItem } from '@kukan/shared'
import { buildQuery } from '@/lib/query'

interface DatasetFiltersProps {
  query: string
  currentOrgs: string[]
  currentGroups: string[]
  currentTags: string[]
  currentFormats: string[]
  currentLicenses: string[]
  facets: FacetCounts
}

type FilterParams = Record<string, string | string[] | undefined>

function buildDatasetUrl(params: FilterParams) {
  return `/dataset?${buildQuery(params)}`
}

function toggleArray(current: string[], value: string): string[] | undefined {
  const set = new Set(current)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  const result = [...set]
  return result.length ? result : undefined
}

function FilterSection({
  icon: Icon,
  title,
  defaultOpen,
  active,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  defaultOpen?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {active && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

function FilterList({
  items,
  activeValues,
  buildHref,
  displayName,
  className,
}: {
  items: FacetItem[]
  activeValues: string[]
  buildHref: (name: string) => string
  displayName?: (item: FacetItem) => string
  className?: string
}) {
  const baseClass = `flex items-center justify-between rounded-md px-2 py-1 text-sm${className ? ` ${className}` : ''}`
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const isActive = activeValues.includes(item.name)
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
  currentOrgs,
  currentGroups,
  currentTags,
  currentFormats,
  currentLicenses,
  facets,
}: DatasetFiltersProps) {
  const t = useTranslations('search')

  const baseParams: FilterParams = {
    q: query || undefined,
    organization: currentOrgs.length ? currentOrgs : undefined,
    groups: currentGroups.length ? currentGroups : undefined,
    tags: currentTags.length ? currentTags : undefined,
    res_format: currentFormats.length ? currentFormats : undefined,
    license_id: currentLicenses.length ? currentLicenses : undefined,
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Organization filter */}
      <FilterSection
        icon={Building2}
        title={t('filterByOrganization')}
        defaultOpen={currentOrgs.length > 0}
        active={currentOrgs.length > 0}
      >
        <FilterList
          items={facets.organizations}
          activeValues={currentOrgs}
          buildHref={(name) =>
            buildDatasetUrl({
              ...baseParams,
              organization: toggleArray(currentOrgs, name),
            })
          }
        />
      </FilterSection>

      {/* Group filter */}
      <FilterSection
        icon={FolderOpen}
        title={t('filterByCategory')}
        defaultOpen={currentGroups.length > 0}
        active={currentGroups.length > 0}
      >
        <FilterList
          items={facets.groups}
          activeValues={currentGroups}
          buildHref={(name) =>
            buildDatasetUrl({
              ...baseParams,
              groups: toggleArray(currentGroups, name),
            })
          }
        />
      </FilterSection>

      {/* Tag filter */}
      <FilterSection
        icon={Tag}
        title={t('filterByTag')}
        defaultOpen={currentTags.length > 0}
        active={currentTags.length > 0}
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
            const newTags = toggleArray(currentTags, tag.name)
            return (
              <Link key={tag.name} href={buildDatasetUrl({ ...baseParams, tags: newTags })}>
                <Badge variant={isSelected ? 'default' : 'secondary'} className="cursor-pointer">
                  {tag.name}
                  <span className="ml-1 text-xs opacity-70">{tag.count}</span>
                </Badge>
              </Link>
            )
          })}
        </div>
      </FilterSection>

      {/* Format filter */}
      {facets.formats.length > 0 && (
        <FilterSection
          icon={FileText}
          title={t('filterByFormat')}
          defaultOpen={currentFormats.length > 0}
          active={currentFormats.length > 0}
        >
          <FilterList
            items={facets.formats}
            activeValues={currentFormats}
            buildHref={(name) =>
              buildDatasetUrl({
                ...baseParams,
                res_format: toggleArray(currentFormats, name),
              })
            }
            className="font-mono uppercase"
          />
        </FilterSection>
      )}

      {/* License filter */}
      {facets.licenses.length > 0 && (
        <FilterSection
          icon={Scale}
          title={t('filterByLicense')}
          defaultOpen={currentLicenses.length > 0}
          active={currentLicenses.length > 0}
        >
          <FilterList
            items={facets.licenses}
            activeValues={currentLicenses}
            buildHref={(name) =>
              buildDatasetUrl({
                ...baseParams,
                license_id: toggleArray(currentLicenses, name),
              })
            }
          />
        </FilterSection>
      )}
    </div>
  )
}
