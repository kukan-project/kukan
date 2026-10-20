import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Separator } from '@kukan/ui'
import { SEARCH_RESULT_WINDOW, type PaginatedResult } from '@kukan/shared'
import { SearchForm } from '@/components/search/search-form'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset/dataset-card'
import { PaginationNav } from '@/components/pagination-nav'

/** The datasets of one organization, group or tag, under a breadcrumb back to its parent. */
export function EntityDatasets({
  parent,
  title,
  description,
  basePath,
  data,
  search,
}: {
  parent: { href: string; label: string }
  title: string
  description?: string | null
  basePath: string
  data: PaginatedResult<DatasetCardItem>
  /** Search within these datasets; left out where the page takes no query */
  search?: { q: string; placeholder: string }
}) {
  const tc = useTranslations('common')

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="text-sm text-muted-foreground">
          <Link href={parent.href} className="hover:text-foreground">
            {parent.label}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{title}</span>
        </nav>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {tc('datasetCount', { count: data.total })}
          </p>
        </div>

        {description && <p className="text-sm text-muted-foreground">{description}</p>}

        {search && (
          <SearchForm action={basePath} defaultValue={search.q} placeholder={search.placeholder} />
        )}

        <Separator />

        {data.items.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground">{tc('noResults')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.items.map((pkg) => (
              <DatasetCard key={pkg.id} pkg={pkg} />
            ))}
          </div>
        )}

        <PaginationNav
          basePath={basePath}
          params={{ q: search?.q || undefined }}
          offset={data.offset}
          limit={data.limit}
          total={data.total}
          maxResults={SEARCH_RESULT_WINDOW}
        />
      </div>
    </div>
  )
}
