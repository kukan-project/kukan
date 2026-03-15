'use client'

import Link from 'next/link'
import {
  Button,
  Badge,
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
import { FormatBadges } from '@/components/format-badges'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'

interface PkgItem {
  id: string
  name: string
  title?: string | null
  private: boolean
  formats?: string
}

export default function DatasetsManagePage() {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const { items, loading, ...pagination } = usePaginatedFetch<PkgItem>(
    '/api/v1/packages?my_org=true'
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tc('datasets')}>
        <Button asChild>
          <Link href="/dashboard/datasets/new">{tc('new')}</Link>
        </Button>
      </PageHeader>

      {loading ? (
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noDatasets')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc('title')}</TableHead>
                <TableHead>{t('visibility')}</TableHead>
                <TableHead>{tc('format')}</TableHead>
                <TableHead className="w-[80px]">{tc('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((pkg) => (
                <TableRow key={pkg.id}>
                  <TableCell className="font-medium">{pkg.title || pkg.name}</TableCell>
                  <TableCell>
                    {pkg.private ? (
                      <Badge variant="secondary">{tc('private')}</Badge>
                    ) : (
                      <Badge>{tc('public')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <FormatBadges formats={pkg.formats} />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/datasets/${pkg.name}/edit`}>{tc('edit')}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls {...pagination} onPageChange={pagination.fetchPage} />
        </>
      )}
    </div>
  )
}
