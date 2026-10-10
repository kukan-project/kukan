'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@kukan/ui'
import { AiSuggestCard } from '@/components/dashboard/ai/ai-suggest-card'
import { AiUsageCard } from '@/components/dashboard/ai/ai-usage-card'
import { PageHeader } from '@/components/dashboard/page-header'
import { SemanticSearchCard } from '@/components/dashboard/ai/semantic-search-card'
import { SummaryGenerationCard } from '@/components/dashboard/ai/summary-generation-card'
import { useFetch } from '@/hooks/use-fetch'

/**
 * Everything the site does with AI: what it all consumed first, then one card
 * per use — the abstracts, the metadata suggestions, and semantic search, last
 * as the one least often touched. They all go through the one AI adapter, so
 * its provider is named once, above them.
 */
export default function AdminAiPage() {
  const t = useTranslations('dashboard.adminAi')
  // The suggestion context carries the adapter's provider; null where AI is off
  const { data } = useFetch<{ provider: string | null }>('/api/v1/admin/settings/ai-suggest')
  // While a bulk action below runs, the usage above follows it
  const [regenerating, setRegenerating] = useState(false)
  const [summarizing, setSummarizing] = useState(false)

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
      <AiUsageCard following={regenerating || summarizing} />
      <SummaryGenerationCard onRunningChange={setSummarizing} />
      <AiSuggestCard />
      <SemanticSearchCard onRunningChange={setRegenerating} />
    </div>
  )
}
