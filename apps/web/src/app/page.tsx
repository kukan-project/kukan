import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button, Card, CardContent, Input, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { serverFetch } from '@/lib/server-api'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'

export default async function HomePage() {
  const t = await getTranslations()
  let datasetTotal = 0
  let orgTotal = 0
  let groupTotal = 0
  let latestDatasets: DatasetCardItem[] = []

  try {
    const [packagesRes, orgsRes, groupsRes] = await Promise.all([
      serverFetch('/api/v1/packages?limit=5'),
      serverFetch('/api/v1/organizations?limit=1'),
      serverFetch('/api/v1/groups?limit=1'),
    ])

    if (packagesRes.ok) {
      const data: PaginatedResult<DatasetCardItem> = await packagesRes.json()
      datasetTotal = data.total
      latestDatasets = data.items
    }
    if (orgsRes.ok) {
      const data: PaginatedResult<unknown> = await orgsRes.json()
      orgTotal = data.total
    }
    if (groupsRes.ok) {
      const data: PaginatedResult<unknown> = await groupsRes.json()
      groupTotal = data.total
    }
  } catch {
    // API unavailable (e.g. during build)
  }

  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] flex-col items-center gap-8 px-4 py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">KUKAN</h1>
        <p className="max-w-lg text-lg text-muted-foreground">{t('home.description')}</p>
      </div>

      <form action="/dataset" method="GET" className="flex w-full max-w-lg gap-2">
        <Input name="q" type="search" placeholder={t('home.searchPlaceholder')} />
        <Button type="submit">{t('common.search')}</Button>
      </form>

      <div className="grid w-full max-w-lg grid-cols-3 gap-4">
        <Link href="/dataset">
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex flex-col items-center py-6">
              <p className="text-3xl font-bold">{datasetTotal}</p>
              <p className="text-sm text-muted-foreground">{t('common.datasets')}</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/organization">
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex flex-col items-center py-6">
              <p className="text-3xl font-bold">{orgTotal}</p>
              <p className="text-sm text-muted-foreground">{t('common.organizations')}</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/group">
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex flex-col items-center py-6">
              <p className="text-3xl font-bold">{groupTotal}</p>
              <p className="text-sm text-muted-foreground">{t('common.categories')}</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {latestDatasets.length > 0 && (
        <>
          <Separator className="w-full max-w-2xl" />
          <section className="flex w-full max-w-2xl flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{t('home.latestDatasets')}</h2>
              <Button asChild variant="outline" size="sm">
                <Link href="/dataset">{t('common.showAll')}</Link>
              </Button>
            </div>
            {latestDatasets.map((pkg) => (
              <DatasetCard key={pkg.id} pkg={pkg} />
            ))}
          </section>
        </>
      )}
    </div>
  )
}
