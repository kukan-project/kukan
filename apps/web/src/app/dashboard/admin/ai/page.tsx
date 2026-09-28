'use client'

import { useTranslations } from 'next-intl'
import { EmbeddingRegenerateCard } from '@/components/dashboard/embedding-regenerate-card'
import { PageHeader } from '@/components/dashboard/page-header'
import { SummaryGenerationCard } from '@/components/dashboard/summary-generation-card'

/**
 * The bulk AI actions: vectors for semantic search, and abstracts. The models
 * and semantic search settings they run under stay on the site page.
 */
export default function AdminAiPage() {
  const t = useTranslations('dashboard.adminAi')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <EmbeddingRegenerateCard />
      <SummaryGenerationCard />
    </div>
  )
}
