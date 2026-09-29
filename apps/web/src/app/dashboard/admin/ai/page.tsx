'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@kukan/ui'
import { AiSuggestCard } from '@/components/dashboard/ai-suggest-card'
import { PageHeader } from '@/components/dashboard/page-header'
import { SemanticSearchCard } from '@/components/dashboard/semantic-search-card'
import { SummaryGenerationCard } from '@/components/dashboard/summary-generation-card'
import { useFetch } from '@/hooks/use-fetch'

/**
 * Everything the site does with AI, one card per use: semantic search, the
 * abstracts, and the metadata suggestions. They all go through the one AI
 * adapter, so its provider is named once, above them.
 */
export default function AdminAiPage() {
  const t = useTranslations('dashboard.adminAi')
  // The suggestion context carries the adapter's provider; null where AI is off
  const { data } = useFetch<{ provider: string | null }>('/api/v1/admin/settings/ai-suggest')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <PageHeader title={t('title')} />
        {data?.provider && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('provider')}</span>
            <Badge variant="outline" className="text-xs">
              {data.provider}
            </Badge>
          </div>
        )}
      </div>
      <SemanticSearchCard />
      <SummaryGenerationCard />
      <AiSuggestCard />
    </div>
  )
}
