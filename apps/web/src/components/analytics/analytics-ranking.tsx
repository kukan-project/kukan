'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
} from '@kukan/ui'
import { PaginationControls } from '@/components/dashboard/pagination-controls'

export interface RankingItem {
  label: string
  value: number
  href?: string
}

export function AnalyticsRanking({
  items,
  loading,
  error,
  labelHeader,
  valueHeader,
  offset,
  total,
  pageSize,
  totalPages,
  currentPage,
  onPageChange,
}: {
  items: RankingItem[]
  loading: boolean
  error: Error | null
  labelHeader: string
  valueHeader: string
  offset: number
  total: number
  pageSize: number
  totalPages: number
  currentPage: number
  onPageChange: (newOffset: number) => void
}) {
  const t = useTranslations('dashboard.adminAnalytics')

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (items.length === 0) {
    return <p className="py-8 text-center text-muted-foreground">{t('noData')}</p>
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">{t('colRank')}</TableHead>
            <TableHead>{labelHeader}</TableHead>
            <TableHead className="w-32 text-right">{valueHeader}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, i) => (
            <TableRow key={`${item.label}-${i}`}>
              <TableCell className="font-medium text-muted-foreground">{offset + i + 1}</TableCell>
              <TableCell>
                {item.href ? (
                  <Link href={item.href} className="text-primary hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {item.value.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <PaginationControls
        offset={offset}
        total={total}
        pageSize={pageSize}
        totalPages={totalPages}
        currentPage={currentPage}
        onPageChange={onPageChange}
      />
    </div>
  )
}
