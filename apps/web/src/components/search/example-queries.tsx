import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { Badge } from '@kukan/ui'
import { brandConfig } from '@/brand'

/** Chips for brandConfig.searchExampleQueries (empty = hidden, ADR-023) */
export function ExampleQueries({ className }: { className?: string }) {
  const t = useTranslations('search')
  const queries = brandConfig.searchExampleQueries
  if (queries.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        {t('exampleQueries')}
      </span>
      {queries.map((query) => (
        <Link key={query} href={`/dataset?q=${encodeURIComponent(query)}`}>
          <Badge variant="outline" className="font-normal transition-colors hover:bg-accent/50">
            {query}
          </Badge>
        </Link>
      ))}
    </div>
  )
}
