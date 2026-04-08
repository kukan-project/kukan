'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

interface UserStatsResponse {
  total: number
  active: number
  sysadmin: number
}

interface UserItem {
  id: string
  name: string
  email: string
  displayName: string | null
  role: string | null
  state: string | null
  createdAt: string
}

const createUserSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  email: z.string().email().max(200),
  password: z.string().min(8),
  role: z.enum(['user', 'sysadmin']),
})

type CreateUserValues = z.infer<typeof createUserSchema>

export default function AdminUsersPage() {
  const user = useUser()
  const locale = useLocale()
  const router = useRouter()
  const t = useTranslations('dashboard.adminUsers')
  const tc = useTranslations('common')

  // sysadmin guard
  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard')
  }, [user.sysadmin, router])

  // Stats
  const [stats, setStats] = useState<UserStatsResponse | null>(null)

  const fetchStats = useCallback(async () => {
    const res = await clientFetch('/api/v1/admin/users/stats')
    if (res.ok) setStats(await res.json())
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebouncedValue(searchQuery)

  const usersUrl = useMemo(
    () =>
      debouncedQuery
        ? `/api/v1/admin/users?q=${encodeURIComponent(debouncedQuery)}`
        : '/api/v1/admin/users',
    [debouncedQuery]
  )

  const { items, loading, error, fetchPage, offset, total, pageSize, totalPages, currentPage } =
    usePaginatedFetch<UserItem>(usersUrl)

  // Refresh
  const [refreshing, setRefreshing] = useState(false)
  const offsetRef = useRef(offset)
  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
    setRefreshing(false)
  }, [fetchPage, fetchStats])

  // Create user dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserValues>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { role: 'user' },
  })

  const onCreateUser = async (values: CreateUserValues) => {
    setCreateError(null)
    const res = await clientFetch('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setCreateError(data.detail || data.message || t('createError'))
      return
    }
    setDialogOpen(false)
    reset()
    await Promise.all([fetchPage(0), fetchStats()])
  }

  const roleBadge = (role: string | null) => {
    if (role === 'sysadmin') return <Badge>{t('roleSysadmin')}</Badge>
    return <Badge variant="outline">{t('roleUser')}</Badge>
  }

  const stateBadge = (state: string | null) => {
    if (state === 'active') return <Badge variant="secondary">{t('stateActive')}</Badge>
    return <Badge variant="destructive">{state ?? 'unknown'}</Badge>
  }

  if (!user.sysadmin) return null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            onClick={() => {
              setCreateError(null)
              reset()
              setDialogOpen(true)
            }}
          >
            {t('createUser')}
          </Button>
        </div>
      </PageHeader>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('statsAll')} value={stats?.total} />
        <StatCard label={t('statsActive')} value={stats?.active} />
        <StatCard label={t('statsSysadmin')} value={stats?.sysadmin} />
      </div>

      {/* Search */}
      <Input
        placeholder={t('searchPlaceholder')}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="max-w-sm"
      />

      {/* Users Table */}
      {loading && !items.length ? (
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-12">
          <p className="text-muted-foreground">{tc('fetchError')}</p>
          <Button variant="outline" size="sm" onClick={() => fetchPage(offset)}>
            {tc('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noUsers')}</p>
      ) : (
        <>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[20%]">{t('colName')}</TableHead>
                <TableHead className="w-[25%]">{t('colEmail')}</TableHead>
                <TableHead className="w-[15%]">{t('colDisplayName')}</TableHead>
                <TableHead className="w-[10%]">{t('colRole')}</TableHead>
                <TableHead className="w-[10%]">{t('colState')}</TableHead>
                <TableHead className="w-[120px]">{t('colCreated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="truncate font-medium" title={u.name}>
                    {u.name}
                  </TableCell>
                  <TableCell className="truncate" title={u.email}>
                    {u.email}
                  </TableCell>
                  <TableCell className="truncate" title={u.displayName ?? undefined}>
                    {u.displayName ?? '-'}
                  </TableCell>
                  <TableCell>{roleBadge(u.role)}</TableCell>
                  <TableCell>{stateBadge(u.state)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTimeCompact(u.createdAt, locale)}
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
            onPageChange={fetchPage}
          />
        </>
      )}

      {/* Create User Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createUserTitle')}</DialogTitle>
            <DialogDescription>{t('createUserDescription')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onCreateUser)} className="flex flex-col gap-4">
            {createError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {createError}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-name">{t('fieldName')}</Label>
              <Input
                id="create-name"
                placeholder={t('fieldNamePlaceholder')}
                {...register('name')}
                aria-invalid={!!errors.name}
              />
              {errors.name && <p className="text-sm text-destructive">{t('fieldNameError')}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-email">{t('fieldEmail')}</Label>
              <Input
                id="create-email"
                type="email"
                placeholder="user@example.com"
                {...register('email')}
                aria-invalid={!!errors.email}
              />
              {errors.email && <p className="text-sm text-destructive">{t('fieldEmailError')}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-password">{t('fieldPassword')}</Label>
              <Input
                id="create-password"
                type="password"
                {...register('password')}
                aria-invalid={!!errors.password}
              />
              {errors.password && (
                <p className="text-sm text-destructive">{t('fieldPasswordError')}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('fieldRole')}</Label>
              <Select
                defaultValue="user"
                onValueChange={(v) => setValue('role', v as 'user' | 'sysadmin')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('roleUser')}</SelectItem>
                  <SelectItem value="sysadmin">{t('roleSysadmin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? tc('creating') : tc('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
