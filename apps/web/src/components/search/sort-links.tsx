import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@kukan/ui'
import { buildQuery } from '@/lib/query'

export type ListOrder = 'name' | 'datasetCount'

export function parseListOrder(value?: string): ListOrder {
  return value === 'datasetCount' ? 'datasetCount' : 'name'
}

/** The default order is left out of the URL, like buildQuery drops a default limit */
export function orderParam(order: ListOrder) {
  return order === 'name' ? undefined : order
}

/**
 * Order switch for the organization and category lists. Links rather than a
 * control, since both pages are server-rendered; the search query rides along
 * so switching the order does not drop what was typed.
 */
export function SortLinks({
  basePath,
  params,
  active,
}: {
  basePath: string
  params?: Record<string, string | string[] | undefined>
  active: ListOrder
}) {
  const t = useTranslations('common')
  const options: { order: ListOrder; label: string }[] = [
    // "URL identifier", not "name": the column is the slug, not the display title
    { order: 'name', label: t('sortByIdentifier') },
    { order: 'datasetCount', label: t('sortByDatasetCount') },
  ]

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-sm text-muted-foreground">{t('sortLabel')}</span>
      {options.map(({ order, label }) => (
        <Button
          key={order}
          asChild
          variant={order === active ? 'secondary' : 'ghost'}
          size="sm"
          aria-current={order === active ? 'true' : undefined}
        >
          <Link href={`${basePath}?${buildQuery({ ...params, orderBy: orderParam(order) })}`}>
            {label}
          </Link>
        </Button>
      ))}
    </div>
  )
}
