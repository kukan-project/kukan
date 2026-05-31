'use client'

import { useTranslations } from 'next-intl'
import { BarChart3, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { brandConfig } from '@/brand'

export default function AdminAnalyticsPage() {
  const t = useTranslations('dashboard.adminAnalytics')

  const isConfigured = !!brandConfig.gaMeasurementId

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {isConfigured ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              {t('title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{t('comingSoon')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              {t('notConfiguredTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-muted-foreground">{t('notConfiguredDescription')}</p>
            <div className="rounded-md bg-muted p-4">
              <p className="mb-2 text-sm font-medium">{t('setupStepsTitle')}</p>
              <ol className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
                <li>{t('setupStep1')}</li>
                <li>{t('setupStep2')}</li>
                <li>{t('setupStep3')}</li>
              </ol>
            </div>
            <a
              href="https://analytics.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              {t('openGA4')}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
