'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { rowActivateProps } from '@/lib/row-activate'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'

interface OrgItem {
  id: string
  name: string
  title?: string
  datasetCount: number
  deletedDatasetCount: number
}

type CategoryFilter = 'public' | 'deleted'

export default function OrganizationsManagePage() {
  const user = useUser()
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const router = useRouter()
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('public')

  // Stats (inactive category fetched separately; active category uses pagination.total)
  const [inactiveStats, setInactiveStats] = useState<Partial<Record<CategoryFilter, number>>>({})

  const fetchInactiveStats = useCallback(async (active: CategoryFilter, sysadmin: boolean) => {
    // Only the non-active category needs its own count (the active one comes from
    // pagination.total). With two categories, at most one fetch runs per call.
    const next: Partial<Record<CategoryFilter, number>> = {}
    try {
      if (active !== 'public') {
        const res = await clientFetch('/api/v1/organizations?limit=1')
        if (res.ok) next.public = (await res.json()).total
      }
      if (active !== 'deleted' && sysadmin) {
        const res = await clientFetch('/api/v1/organizations?state=deleted&limit=1')
        if (res.ok) next.deleted = (await res.json()).total
      }
    } catch {
      // Silently ignore — stat cards will show stale or missing values
    }
    setInactiveStats(next)
  }, [])

  useEffect(() => {
    fetchInactiveStats(activeCategory, user.sysadmin)
  }, [fetchInactiveStats, activeCategory, user.sysadmin])

  const showDeleted = activeCategory === 'deleted'
  const listUrl = showDeleted ? '/api/v1/organizations?state=deleted' : '/api/v1/organizations'
  const { items, loading, error, ...pagination } = usePaginatedFetch<OrgItem>(listUrl)

  // Merge active category total from pagination with inactive stats
  const stats: Record<CategoryFilter, number | undefined> = {
    public: activeCategory === 'public' ? pagination.total : inactiveStats.public,
    deleted: activeCategory === 'deleted' ? pagination.total : inactiveStats.deleted,
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('manageTitle')}>
        {user.sysadmin && (
          <Button asChild>
            <Link href="/dashboard/organizations/new">{tc('new')}</Link>
          </Button>
        )}
      </PageHeader>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('tabPublic')}
          value={stats.public}
          active={activeCategory === 'public'}
          onClick={() => setActiveCategory('public')}
        />
        {user.sysadmin && (
          <StatCard
            label={t('tabDeleted')}
            value={stats.deleted}
            variant="destructive"
            active={activeCategory === 'deleted'}
            onClick={() => setActiveCategory('deleted')}
          />
        )}
      </div>

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
        <p className="py-12 text-center text-muted-foreground">
          {showDeleted ? t('noDeletedOrganizations') : t('noOrganizations')}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc('urlIdentifier')}</TableHead>
                <TableHead>{tc('title')}</TableHead>
                <TableHead className="text-right">{tc('datasets')}</TableHead>
                <TableHead className="w-[80px]">{tc('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((org) => {
                const editHref = `/dashboard/organizations/${org.name}/edit${
                  showDeleted ? '?state=deleted' : ''
                }`
                return (
                  <TableRow key={org.id} {...rowActivateProps(() => router.push(editHref))}>
                    <TableCell className="font-medium">{org.name}</TableCell>
                    <TableCell>{org.title || '-'}</TableCell>
                    <TableCell className="text-right">
                      {org.datasetCount + org.deletedDatasetCount}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {t('deletedDatasetCount', { count: org.deletedDatasetCount })}
                      </span>
                    </TableCell>
                    <TableCell>
                      {/* Row click opens the editor; these nested links act on their own. */}
                      {!showDeleted && (
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/dashboard/organizations/${org.name}/members`}>
                              {tc('members')}
                            </Link>
                          </Button>
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/organization/${org.name}`}>{tc('view')}</Link>
                          </Button>
                        </div>
                      )}
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
