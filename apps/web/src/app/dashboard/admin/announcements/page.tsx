'use client'

import Link from 'next/link'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { clientFetch } from '@/lib/client-api'

interface AnnouncementItem {
  id: string
  title: string
  category: string
  publishedAt: string | null
  created: string
}

function getStatus(publishedAt: string | null): 'published' | 'scheduled' | 'draft' {
  if (!publishedAt) return 'draft'
  return new Date(publishedAt) <= new Date() ? 'published' : 'scheduled'
}

export default function AnnouncementsManagePage() {
  const t = useTranslations('announcement')
  const tc = useTranslations('common')
  const { items, loading, error, ...pagination } = usePaginatedFetch<AnnouncementItem>(
    '/api/v1/announcements?publishedOnly=false'
  )

  const handleDelete = async (id: string) => {
    if (!confirm(t('confirmDelete'))) return
    const res = await clientFetch(`/api/v1/announcements/${id}`, { method: 'DELETE' })
    if (res.ok) pagination.fetchPage(pagination.offset)
  }

  const statusVariant = {
    published: 'default' as const,
    scheduled: 'secondary' as const,
    draft: 'outline' as const,
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('announcements')}>
        <Button asChild>
          <Link href="/dashboard/admin/announcements/new">{tc('new')}</Link>
        </Button>
      </PageHeader>

      {loading ? (
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-12">
          <p className="text-muted-foreground">{tc('fetchError')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => pagination.fetchPage(pagination.offset)}
          >
            {tc('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noAnnouncements')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('title')}</TableHead>
                <TableHead>{t('category')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead>{t('publishedAt')}</TableHead>
                <TableHead className="w-[120px]">{tc('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const status = getStatus(item.publishedAt)
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.title}</TableCell>
                    <TableCell>{t(`category_${item.category}`)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[status]}>{t(status)}</Badge>
                    </TableCell>
                    <TableCell>
                      {item.publishedAt ? new Date(item.publishedAt).toLocaleString() : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/dashboard/admin/announcements/${item.id}/edit`}>
                            {tc('edit')}
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(item.id)}>
                          {tc('delete')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <PaginationControls {...pagination} onPageChange={pagination.fetchPage} />
        </>
      )}
    </div>
  )
}
