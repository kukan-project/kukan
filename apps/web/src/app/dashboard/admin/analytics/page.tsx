'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { BarChart3, Info } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { AnalyticsDateRange, DEFAULT_DATE_RANGE } from '@/components/analytics/analytics-date-range'
import { AnalyticsRanking } from '@/components/analytics/analytics-ranking'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'

type TabType = 'dataset-views' | 'resource-views' | 'downloads' | 'search-terms'

export default function AdminAnalyticsPage() {
  const t = useTranslations('dashboard.adminAnalytics')

  const [activeTab, setActiveTab] = useState<TabType>('dataset-views')
  const [startDate, setStartDate] = useState(DEFAULT_DATE_RANGE.startDate)
  const [endDate, setEndDate] = useState(DEFAULT_DATE_RANGE.endDate)

  const analyticsUrl = useMemo(
    () =>
      `/api/v1/admin/analytics/${activeTab}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
    [activeTab, startDate, endDate]
  )

  const { items, loading, error, offset, total, pageSize, totalPages, currentPage, fetchPage } =
    usePaginatedFetch<{ label: string; value: number; href?: string }>(analyticsUrl)

  // GA4 Data API not configured (env vars missing)
  const isNotConfigured = !loading && error?.message.includes('404')
  if (isNotConfigured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('title')} />
        <NotConfiguredCard />
      </div>
    )
  }

  const valueHeader =
    activeTab === 'downloads'
      ? t('colDownloads')
      : activeTab === 'search-terms'
        ? t('colSearchCount')
        : t('colViews')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <AnalyticsDateRange
          startDate={startDate}
          endDate={endDate}
          onRangeChange={(s, e) => {
            setStartDate(s)
            setEndDate(e)
          }}
        />
      </PageHeader>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
        <TabsList>
          <TabsTrigger value="dataset-views">{t('tabDatasetViews')}</TabsTrigger>
          <TabsTrigger value="resource-views">{t('tabResourceViews')}</TabsTrigger>
          <TabsTrigger value="downloads">{t('tabDownloads')}</TabsTrigger>
          <TabsTrigger value="search-terms">{t('tabSearchTerms')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <AnalyticsRanking
        items={items}
        loading={loading}
        error={error}
        labelHeader={t('colLabel')}
        valueHeader={valueHeader}
        offset={offset}
        total={total}
        pageSize={pageSize}
        totalPages={totalPages}
        currentPage={currentPage}
        onPageChange={fetchPage}
      />

      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Info className="h-3 w-3" />
        {t('dataDelay')}
      </p>
    </div>
  )
}

function NotConfiguredCard() {
  const t = useTranslations('dashboard.adminAnalytics')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          {t('backendNotConfiguredTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground">{t('backendNotConfiguredDescription')}</p>
        <div className="rounded-md bg-muted p-4">
          <p className="mb-2 text-sm font-medium">{t('setupStepsTitle')}</p>
          <ol className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
            <li>{t('backendSetupStep1')}</li>
            <li>{t('backendSetupStep2')}</li>
            <li>{t('backendSetupStep3')}</li>
            <li>{t('backendSetupStep4')}</li>
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}
