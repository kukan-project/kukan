'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { useUser } from '@/components/dashboard/user-provider'

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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    clientFetch('/api/v1/packages?my_org=true&limit=5').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setItems(data.items)
        setTotal(data.total)
      }
      setLoading(false)
    })
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('welcome', { name: user.name })}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('datasetCount')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{loading ? '-' : total}</p>
          </CardContent>
        </Card>
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
                  <div className="flex gap-1">
                    {pkg.formats
                      ?.split(',')
                      .filter(Boolean)
                      .map((f: string) => (
                        <Badge key={f} variant="outline">
                          {f}
                        </Badge>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
