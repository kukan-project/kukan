'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { useUser } from '@/components/dashboard/user-provider'
import { StatCard } from '@/components/dashboard/stat-card'
import { FormatBadges } from '@/components/format-badges'

interface PkgItem {
  id: string
  name: string
  title?: string | null
  private: boolean
  formats?: string
}

export default function DashboardPage() {
  const user = useUser()
  const t = useTranslations('dashboard')
  const tc = useTranslations('common')
  const [items, setItems] = useState<PkgItem[]>([])
  const [total, setTotal] = useState(0)
  const [resourceTotal, setResourceTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      clientFetch('/api/v1/packages?my_org=true&limit=5'),
      clientFetch('/api/v1/resources/count?my_org=true'),
    ])
      .then(async ([pkgRes, resCountRes]) => {
        if (pkgRes.ok) {
          const data = await pkgRes.json()
          setItems(data.items)
          setTotal(data.total)
        }
        if (resCountRes.ok) {
          const data = await resCountRes.json()
          setResourceTotal(data.count)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('welcome', { name: user.name })}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label={t('datasetCount')} value={loading ? undefined : total} />
        <StatCard label={t('resourceCount')} value={loading ? undefined : resourceTotal} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('recentDatasets')}</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/datasets">{tc('showAll')}</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-muted-foreground">{tc('loading')}</p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <p className="text-muted-foreground">{t('noDatasets')}</p>
              <Button asChild>
                <Link href="/dashboard/datasets/new">{t('createDataset')}</Link>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col divide-y">
              {items.map((pkg) => (
                <div key={pkg.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/datasets/${pkg.name}/edit`}
                      className="font-medium hover:underline"
                    >
                      {pkg.title || pkg.name}
                    </Link>
                    {pkg.private && <Badge variant="secondary">{tc('private')}</Badge>}
                  </div>
                  <FormatBadges formats={pkg.formats} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
