import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Button, Card, CardContent, Input, Separator } from '@kukan/ui'
import type { PaginatedResult } from '@kukan/shared'
import { overrides } from '@/brand'
import { serverFetch } from '@/lib/server-api'
import { safeExternalHref } from '@/lib/safe-url'
import { DatasetCard, type DatasetCardItem } from '@/components/dataset-card'
import { CompactDate } from '@/components/date-time'

export default async function HomePage() {
  const Custom = overrides.TopPage
  if (Custom) return <Custom />
  const t = await getTranslations()
  let datasetTotal = 0
  let resourceTotal = 0
  let orgTotal = 0
  let groupTotal = 0
  let latestDatasets: DatasetCardItem[] = []
  let announcements: {
    id: string
    title: string
    category: string
    link?: string | null
    publishedAt: string
  }[] = []

  const announcementsPromise = serverFetch('/api/v1/announcements?limit=5')
    .then(async (res) => {
      if (res.ok) announcements = (await res.json()).items
    })
    .catch(() => {})

  try {
    const [packagesRes, resourceCountRes, orgsRes, groupsRes] = await Promise.all([
      serverFetch('/api/v1/packages?limit=5'),
      serverFetch('/api/v1/resources/count'),
      serverFetch('/api/v1/organizations?limit=1'),
      serverFetch('/api/v1/groups?limit=1'),
    ])

    if (packagesRes.ok) {
      const data: PaginatedResult<DatasetCardItem> = await packagesRes.json()
      datasetTotal = data.total
      latestDatasets = data.items
    }
    if (resourceCountRes.ok) {
      const data = await resourceCountRes.json()
      resourceTotal = data.count
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

  await announcementsPromise

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

      <div className="grid w-full max-w-2xl grid-cols-4 gap-4">
        <Link href="/dataset">
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex flex-col items-center py-6">
              <p className="text-3xl font-bold">{datasetTotal}</p>
              <p className="text-sm text-muted-foreground">{t('common.datasets')}</p>
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center py-6">
            <p className="text-3xl font-bold">{resourceTotal}</p>
            <p className="text-sm text-muted-foreground">{t('common.resources')}</p>
          </CardContent>
        </Card>
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

      {announcements.length > 0 && (
        <>
          <Separator className="w-full max-w-2xl" />
          <section className="flex w-full max-w-2xl flex-col gap-3">
            <h2 className="text-xl font-semibold">{t('home.announcements')}</h2>
            {announcements.map((a) => {
              const href = safeExternalHref(a.link)
              return (
                <div key={a.id} className="flex items-baseline gap-3 text-sm">
                  <span className="shrink-0 text-muted-foreground">
                    <CompactDate value={a.publishedAt} />
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {t(`announcement.category_${a.category}`)}
                  </Badge>
                  {href ? (
                    <a
                      href={href}
                      className="hover:underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {a.title}
                    </a>
                  ) : (
                    <span>{a.title}</span>
                  )}
                </div>
              )
            })}
          </section>
        </>
      )}

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
