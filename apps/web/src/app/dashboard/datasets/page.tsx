'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Button,
  Badge,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { Building2, FolderOpen, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { parseGroups } from '@/lib/parse-groups'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { FormatBadges } from '@/components/format-badges'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useDebouncedValue } from '@/hooks/use-debounced-value'

interface PkgItem {
  id: string
  name: string
  title?: string | null
  private: boolean
  formats?: string
  orgName?: string | null
  orgTitle?: string | null
  tags?: string
  groups?: string
}

interface OptionItem {
  id: string
  name: string
  title?: string | null
}

const ALL = '__all__'

type CategoryFilter = 'public' | 'private' | 'deleted'

export default function DatasetsManagePage() {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')

  // Filter state
  const [nameFilter, setNameFilter] = useState('')
  const debouncedName = useDebouncedValue(nameFilter)
  const [keyword, setKeyword] = useState('')
  const debouncedKeyword = useDebouncedValue(keyword)
  const [orgFilter, setOrgFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('public')

  // Stats (inactive categories fetched separately; active category uses pagination.total)
  const [inactiveStats, setInactiveStats] = useState<Partial<Record<CategoryFilter, number>>>({})

  const fetchInactiveStats = useCallback(async (active: CategoryFilter) => {
    try {
      const calls: { key: CategoryFilter; url: string }[] = []
      if (active !== 'public')
        calls.push({ key: 'public', url: '/api/v1/packages?my_org=true&private=false&limit=1' })
      if (active !== 'private')
        calls.push({ key: 'private', url: '/api/v1/packages?my_org=true&private=true&limit=1' })
      if (active !== 'deleted')
        calls.push({
          key: 'deleted',
          url: '/api/v1/packages?my_org=true&state=deleted&limit=1',
        })
      const responses = await Promise.all(calls.map((c) => clientFetch(c.url)))
      const results = await Promise.all(responses.map((r) => (r.ok ? r.json() : null)))
      const newStats: Partial<Record<CategoryFilter, number>> = {}
      calls.forEach((c, i) => {
        if (results[i]) newStats[c.key] = results[i].total
      })
      setInactiveStats(newStats)
    } catch {
      // Silently ignore — stat cards will show stale or missing values
    }
  }, [])

  // Filter options
  const [organizations, setOrganizations] = useState<OptionItem[]>([])
  const [groups, setGroups] = useState<OptionItem[]>([])

  // Fetch org/group filter options once on mount
  useEffect(() => {
    Promise.all([
      clientFetch('/api/v1/organizations?limit=100'),
      clientFetch('/api/v1/groups?limit=100'),
    ])
      .then(async ([orgRes, grpRes]) => {
        if (orgRes.ok) {
          const data = await orgRes.json()
          setOrganizations(data.items)
        }
        if (grpRes.ok) {
          const data = await grpRes.json()
          setGroups(data.items)
        }
      })
      .catch(() => {})
  }, [])

  // Refetch inactive stats when active category changes
  useEffect(() => {
    fetchInactiveStats(activeCategory)
  }, [fetchInactiveStats, activeCategory])

  // Build dynamic URL
  const filterUrl = useMemo(() => {
    const params = new URLSearchParams({ my_org: 'true' })
    if (debouncedName) params.set('name', debouncedName)
    if (debouncedKeyword) params.set('q', debouncedKeyword)
    if (orgFilter) params.set('organization', orgFilter)
    if (groupFilter) params.set('groups', groupFilter)
    if (activeCategory === 'public') params.set('private', 'false')
    else if (activeCategory === 'private') params.set('private', 'true')
    else if (activeCategory === 'deleted') params.set('state', 'deleted')
    return `/api/v1/packages?${params}`
  }, [debouncedName, debouncedKeyword, orgFilter, groupFilter, activeCategory])

  const { items, loading, error, ...pagination } = usePaginatedFetch<PkgItem>(filterUrl)

  // Merge active category total from pagination with inactive stats
  const stats: Record<CategoryFilter, number | undefined> = {
    public: activeCategory === 'public' ? pagination.total : inactiveStats.public,
    private: activeCategory === 'private' ? pagination.total : inactiveStats.private,
    deleted: activeCategory === 'deleted' ? pagination.total : inactiveStats.deleted,
  }

  function handleSelect(setter: (v: string) => void) {
    return (value: string) => setter(value === ALL ? '' : value)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('manageTitle')}>
        <Button asChild>
          <Link href="/dashboard/datasets/new">{tc('new')}</Link>
        </Button>
      </PageHeader>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('tabPublic')}
          value={stats.public}
          active={activeCategory === 'public'}
          onClick={() => setActiveCategory('public')}
        />
        <StatCard
          label={t('tabPrivate')}
          value={stats.private}
          active={activeCategory === 'private'}
          onClick={() => setActiveCategory('private')}
        />
        <StatCard
          label={t('tabDeleted')}
          value={stats.deleted}
          variant="destructive"
          active={activeCategory === 'deleted'}
          onClick={() => setActiveCategory('deleted')}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{tc('organizations')}</Label>
          <Select value={orgFilter || ALL} onValueChange={handleSelect(setOrgFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tc('showAll')}</SelectItem>
              {organizations.map((org) => (
                <SelectItem key={org.id} value={org.name}>
                  {org.title || org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{tc('categories')}</Label>
          <Select value={groupFilter || ALL} onValueChange={handleSelect(setGroupFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tc('showAll')}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.name}>
                  {g.title || g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{tc('name')}</Label>
          <Input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{tc('title')}</Label>
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
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
        <p className="py-12 text-center text-muted-foreground">{t('noDatasets')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc('name')}</TableHead>
                <TableHead colSpan={2}>{tc('title')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('visibility')}</TableHead>
                <TableHead className="whitespace-nowrap">{tc('format')}</TableHead>
                <TableHead className="w-[80px] whitespace-nowrap">{tc('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((pkg) => {
                const pkgGroups = parseGroups(pkg.groups)
                const pkgTags = pkg.tags?.split(',').filter(Boolean) ?? []
                return (
                  <TableRow key={pkg.id}>
                    <TableCell className="font-mono text-sm">{pkg.name}</TableCell>
                    <TableCell colSpan={2}>
                      <div className="font-medium">{pkg.title || '-'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {pkg.orgTitle && (
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {pkg.orgTitle}
                          </span>
                        )}
                        {pkgGroups.length > 0 && (
                          <span className="flex items-center gap-1">
                            <FolderOpen className="h-3 w-3" />
                            {pkgGroups.map((g) => g.title).join(', ')}
                          </span>
                        )}
                        {pkgTags.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Tag className="h-3 w-3" />
                            {pkgTags.join(', ')}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {activeCategory === 'deleted' ? (
                        <Badge variant="destructive">{t('tabDeleted')}</Badge>
                      ) : pkg.private ? (
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
                        <Link
                          href={
                            activeCategory === 'deleted'
                              ? `/dashboard/datasets/${pkg.name}/edit?state=deleted`
                              : `/dashboard/datasets/${pkg.name}/edit`
                          }
                        >
                          {tc('edit')}
                        </Link>
                      </Button>
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
