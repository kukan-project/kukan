import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Building2,
  FolderOpen,
  Tag,
  FileText,
  Scale,
  ChevronDown,
  MapPin,
  Link2,
} from 'lucide-react'
import { Badge } from '@kukan/ui'
import { NATIONWIDE, resolveLicenseLabel, type FacetCounts, type FacetItem } from '@kukan/shared'
import { ExperimentalMark } from '@/components/experimental-mark'
import { buildQuery } from '@/lib/query'

interface DatasetFiltersProps {
  /** Params every facet link must carry — built once in dataset-list.tsx */
  baseParams: FilterParams
  facets: FacetCounts
}

type FilterParams = Record<string, string | string[] | undefined>

function toArray(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

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
  experimental,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  defaultOpen?: boolean
  active?: boolean
  /** Marked as a feature whose behaviour may still change */
  experimental?: boolean
  children: React.ReactNode
}) {
  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {experimental && <ExperimentalMark />}
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
  below,
}: {
  items: FacetItem[]
  activeValues: string[]
  buildHref: (name: string) => string
  displayName?: (item: FacetItem) => string
  className?: string
  /** What goes under an item's row, inside its entry: the places under an area */
  below?: (item: FacetItem) => React.ReactNode
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
              {below?.(item)}
            </li>
          )
        }
        return (
          <li key={item.name}>
            <Link
              href={buildHref(item.name)}
              // Filter combinations are endless; robots.txt turns them away too
              rel="nofollow"
              className={`${baseClass} transition-colors hover:bg-accent ${
                isActive ? 'bg-accent font-medium' : 'text-muted-foreground'
              }`}
            >
              {content}
            </Link>
            {below?.(item)}
          </li>
        )
      })}
    </ul>
  )
}

export function DatasetFilters({ baseParams, facets }: DatasetFiltersProps) {
  const t = useTranslations('search')
  const tl = useTranslations('license')

  // Active selections derive from baseParams — one representation of URL state
  const currentOrgs = toArray(baseParams.organization)
  const currentGroups = toArray(baseParams.groups)
  const currentTags = toArray(baseParams.tags)
  const currentFormats = toArray(baseParams.res_format)
  const currentLicenses = toArray(baseParams.license_id)
  const currentAreas = toArray(baseParams.area)
  const currentAreaPlaces = toArray(baseParams.area_place)
  const currentMeanings = toArray(baseParams.meaning)
  const tv = useTranslations('resource.vocabulary')
  const meaningLabel = (name: string) => {
    const [concept, kind] = name.split(':')
    const conceptKey = `concepts.${concept}`
    return t('meaningLabel', {
      concept: tv.has(conceptKey) ? tv(conceptKey) : concept,
      kind: t.has(`meaningKinds.${kind}`) ? t(`meaningKinds.${kind}`) : kind,
    })
  }
  const placeList = (places: FacetItem[]) =>
    places.length > 0 && (
      <div className="mt-1 mb-1 ml-2 border-l pl-3">
        <FilterList
          items={places}
          activeValues={currentAreaPlaces}
          buildHref={(name) =>
            buildDatasetUrl({ ...baseParams, area_place: toggleArray(currentAreaPlaces, name) })
          }
        />
      </div>
    )
  // Taking an area away takes the places chosen under it with it: left alone
  // they would narrow the results with nothing on the screen to undo them
  const withoutArea = (area: string) => {
    const under = new Set(facets.areaPlaces.filter((p) => p.parent === area).map((p) => p.name))
    const places = currentAreaPlaces.filter((p) => !under.has(p))
    return places.length ? places : undefined
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
                  <Badge variant="secondary" wrap className="cursor-default">
                    {tag.name}
                    <span className="ml-1 text-xs opacity-70">{tag.count}</span>
                  </Badge>
                </span>
              )
            }
            const newTags = toggleArray(currentTags, tag.name)
            return (
              <Link
                key={tag.name}
                href={buildDatasetUrl({ ...baseParams, tags: newTags })}
                rel="nofollow"
              >
                <Badge
                  variant={isSelected ? 'default' : 'secondary'}
                  wrap
                  className="cursor-pointer"
                >
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

      {/* What tables' columns stand for (ADR-073; experimental) */}
      {(facets.areas.length > 0 || currentAreas.length > 0 || currentAreaPlaces.length > 0) && (
        <FilterSection
          icon={MapPin}
          title={t('filterByArea')}
          experimental
          defaultOpen={currentAreas.length > 0 || currentAreaPlaces.length > 0}
          active={currentAreas.length > 0 || currentAreaPlaces.length > 0}
        >
          <FilterList
            items={facets.areas}
            activeValues={currentAreas}
            buildHref={(name) => {
              const removing = currentAreas.includes(name)
              return buildDatasetUrl({
                ...baseParams,
                area: toggleArray(currentAreas, name),
                ...(removing && { area_place: withoutArea(name) }),
              })
            }}
            displayName={(item) =>
              item.name === NATIONWIDE ? t('areaNationwide') : item.title || item.name
            }
            // An area's places right under its own row, not after every area
            below={(area) => placeList(facets.areaPlaces.filter((p) => p.parent === area.name))}
          />
          {/* Places chosen with no area of theirs listed: still there to take away */}
          {placeList(
            facets.areaPlaces.filter((p) => !facets.areas.some((a) => a.name === p.parent))
          )}
        </FilterSection>
      )}

      {(facets.meanings.length > 0 || currentMeanings.length > 0) && (
        <FilterSection
          icon={Link2}
          title={t('filterByMeaning')}
          experimental
          defaultOpen={currentMeanings.length > 0}
          active={currentMeanings.length > 0}
        >
          <FilterList
            items={facets.meanings}
            activeValues={currentMeanings}
            buildHref={(name) =>
              buildDatasetUrl({
                ...baseParams,
                meaning: toggleArray(currentMeanings, name),
              })
            }
            displayName={(item) => meaningLabel(item.name)}
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
            displayName={(item) => resolveLicenseLabel(item.name, tl)}
          />
        </FilterSection>
      )}
    </div>
  )
}
