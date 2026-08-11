'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useLocale, useTranslations } from 'next-intl'
import { useForm, useWatch, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Trash2, RotateCcw, XCircle } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Input,
  Field,
  FieldControl,
  FieldLabel,
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
import { rowActivateProps } from '@/lib/row-activate'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatCard } from '@/components/dashboard/stat-card'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { userNameSchema, userRoleSchema, passwordLengthSchema, type UserRole } from '@kukan/shared'
import { PASSWORD_LENGTH_KEYS, passwordLengthArgs } from '@/lib/password-messages'
import { PasswordField } from '@/components/password-field'
import { PasswordStrengthMeter } from '@/components/password-strength-meter'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { formatDateTimeCompact } from '@/components/date-time'

interface UserStatsResponse {
  total: number
  active: number
  sysadmin: number
  deleted: number
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
  name: userNameSchema,
  email: z.email().max(200),
  password: passwordLengthSchema(PASSWORD_LENGTH_KEYS),
  displayName: z.string().max(200).optional(),
  role: userRoleSchema,
})

type CreateUserValues = z.infer<typeof createUserSchema>

const editUserSchema = z.object({
  name: userNameSchema,
  displayName: z.string().max(200).optional(),
  role: userRoleSchema,
})

type EditUserValues = z.infer<typeof editUserSchema>

/**
 * The meter's own subscriber: `watch` on the page would re-render the table and
 * every dialog on each keystroke in the create form.
 */
function CreateUserStrength({ control }: { control: Control<CreateUserValues> }) {
  const [password, name, email, displayName] = useWatch({
    control,
    name: ['password', 'name', 'email', 'displayName'],
  })
  return <PasswordStrengthMeter password={password ?? ''} account={{ name, email, displayName }} />
}

export default function AdminUsersPage() {
  const user = useUser()
  const locale = useLocale()
  const t = useTranslations('dashboard.adminUsers')
  const tc = useTranslations('common')
  const tp = useTranslations('password')

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

  const offsetRef = useRef(offset)
  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  // Create user dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
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
      body: JSON.stringify({ ...values, displayName: values.displayName || undefined }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setCreateError(
        data.title === 'PASSWORD_TOO_WEAK'
          ? tp('tooWeak')
          : data.detail || data.message || t('createError')
      )
      return
    }
    setDialogOpen(false)
    reset()
    await Promise.all([fetchPage(0), fetchStats()])
  }

  // Edit user dialog
  const [editTarget, setEditTarget] = useState<UserItem | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const editForm = useForm<EditUserValues>({
    resolver: zodResolver(editUserSchema),
  })

  const openEditDialog = (u: UserItem) => {
    setEditError(null)
    editForm.reset({
      name: u.name,
      displayName: u.displayName ?? '',
      role: (u.role ?? 'user') as UserRole,
    })
    setEditTarget(u)
  }

  const onEditUser = async (values: EditUserValues) => {
    if (!editTarget) return
    setEditError(null)
    const res = await clientFetch(`/api/v1/admin/users/${editTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        displayName: values.displayName || undefined,
        role: values.role,
      }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setEditError(data.detail || data.message || t('editError'))
      return
    }
    setEditTarget(null)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
  }

  // Delete user dialog
  const [deleteTarget, setDeleteTarget] = useState<UserItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const onDeleteUser = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    setDeleteError(null)
    const res = await clientFetch(`/api/v1/admin/users/${deleteTarget.id}`, { method: 'DELETE' })
    setIsDeleting(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setDeleteError(data.detail || data.message || t('deleteError'))
      return
    }
    setDeleteTarget(null)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
  }

  // Restore user
  const [restoreTarget, setRestoreTarget] = useState<UserItem | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const onRestoreUser = async () => {
    if (!restoreTarget) return
    setIsRestoring(true)
    setRestoreError(null)
    const res = await clientFetch(`/api/v1/admin/users/${restoreTarget.id}/restore`, {
      method: 'POST',
    })
    setIsRestoring(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setRestoreError(data.detail || t('restoreError'))
      return
    }
    setRestoreTarget(null)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
  }

  // Purge user dialog
  const [purgeTarget, setPurgeTarget] = useState<UserItem | null>(null)
  const [isPurging, setIsPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)

  const onPurgeUser = async () => {
    if (!purgeTarget) return
    setIsPurging(true)
    setPurgeError(null)
    const res = await clientFetch(`/api/v1/admin/users/${purgeTarget.id}/purge`, { method: 'POST' })
    setIsPurging(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setPurgeError(data.detail || t('purgeError'))
      return
    }
    setPurgeTarget(null)
    await Promise.all([fetchPage(offsetRef.current), fetchStats()])
  }

  const roleBadge = (role: string | null) => {
    if (role === 'sysadmin') return <Badge>{t('roleSysadmin')}</Badge>
    return <Badge variant="outline">{t('roleUser')}</Badge>
  }

  const stateBadge = (state: string | null) => {
    if (state === 'active') return <Badge variant="secondary">{t('stateActive')}</Badge>
    if (state === 'deleted') return <Badge variant="destructive">{t('stateDeleted')}</Badge>
    return <Badge variant="destructive">{state ?? 'unknown'}</Badge>
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <Button
          onClick={() => {
            setCreateError(null)
            reset()
            setDialogOpen(true)
          }}
        >
          {t('createUser')}
        </Button>
      </PageHeader>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('statsSysadmin')} value={stats?.sysadmin} />
        <StatCard
          label={t('statsRegularUser')}
          value={stats ? stats.active - stats.sysadmin : undefined}
        />
        <StatCard label={t('statsDeleted')} value={stats?.deleted} />
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
                <TableHead className="w-[15%]">{t('colName')}</TableHead>
                <TableHead className="w-[22%]">{t('colEmail')}</TableHead>
                <TableHead className="w-[13%]">{t('colDisplayName')}</TableHead>
                <TableHead className="w-[110px]">{t('colRole')}</TableHead>
                <TableHead className="w-[80px]">{t('colState')}</TableHead>
                <TableHead className="w-[120px]">{t('colCreated')}</TableHead>
                <TableHead className="w-[120px]">{t('colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow
                  key={u.id}
                  {...rowActivateProps(() => openEditDialog(u), {
                    role: 'button',
                    className: u.state !== 'active' ? 'opacity-50' : undefined,
                  })}
                >
                  <TableCell className="truncate font-medium" title={u.name}>
                    {u.name}
                  </TableCell>
                  <TableCell className="truncate" title={u.email}>
                    {u.email}
                  </TableCell>
                  <TableCell className="truncate" title={u.displayName ?? undefined}>
                    {u.displayName ?? '-'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{roleBadge(u.role)}</TableCell>
                  <TableCell className="whitespace-nowrap">{stateBadge(u.state)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTimeCompact(u.createdAt, locale)}
                  </TableCell>
                  <TableCell>
                    {/* Row click opens the edit dialog; these buttons act on their own. */}
                    <div className="flex items-center gap-1">
                      {u.id !== user.id && u.state === 'active' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => {
                            setDeleteError(null)
                            setDeleteTarget(u)
                          }}
                          title={t('deleteUser')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                      {u.id !== user.id && u.state === 'deleted' && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => {
                              setRestoreError(null)
                              setRestoreTarget(u)
                            }}
                            title={t('restoreUser')}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              setPurgeError(null)
                              setPurgeTarget(u)
                            }}
                            title={t('purgeUser')}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
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
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            <Field id="create-name" error={errors.name && t('fieldNameError')}>
              <FieldLabel>{t('fieldName')}</FieldLabel>
              <FieldControl>
                <Input placeholder={t('fieldNamePlaceholder')} {...register('name')} />
              </FieldControl>
            </Field>
            <Field id="create-displayName">
              <FieldLabel>{t('fieldDisplayName')}</FieldLabel>
              <FieldControl>
                <Input
                  placeholder={t('fieldDisplayNamePlaceholder')}
                  {...register('displayName')}
                />
              </FieldControl>
            </Field>
            <Field id="create-email" error={errors.email && t('fieldEmailError')}>
              <FieldLabel>{t('fieldEmail')}</FieldLabel>
              <FieldControl>
                <Input type="email" placeholder="user@example.com" {...register('email')} />
              </FieldControl>
            </Field>
            <div className="flex flex-col gap-2">
              <PasswordField
                id="create-password"
                label={t('fieldPassword')}
                autoComplete="new-password"
                error={
                  errors.password &&
                  tp(
                    errors.password.message ?? PASSWORD_LENGTH_KEYS.tooShort,
                    passwordLengthArgs(errors.password.message)
                  )
                }
                {...register('password')}
              />
              <CreateUserStrength control={control} />
            </div>
            <Field>
              <FieldLabel>{t('fieldRole')}</FieldLabel>
              <Select defaultValue="user" onValueChange={(v) => setValue('role', v as UserRole)}>
                <FieldControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FieldControl>
                <SelectContent>
                  <SelectItem value="user">{t('roleUser')}</SelectItem>
                  <SelectItem value="sysadmin">{t('roleSysadmin')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? tc('creating') : tc('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editUserTitle')}</DialogTitle>
            <DialogDescription>{t('editUserDescription')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditUser)} className="flex flex-col gap-4">
            {editError && (
              <Alert variant="destructive">
                <AlertDescription>{editError}</AlertDescription>
              </Alert>
            )}
            <Field id="edit-name" error={editForm.formState.errors.name && t('fieldNameError')}>
              <FieldLabel>{t('fieldName')}</FieldLabel>
              <FieldControl>
                <Input placeholder={t('fieldNamePlaceholder')} {...editForm.register('name')} />
              </FieldControl>
            </Field>
            <Field id="edit-displayName">
              <FieldLabel>{t('fieldDisplayName')}</FieldLabel>
              <FieldControl>
                <Input
                  placeholder={t('fieldDisplayNamePlaceholder')}
                  {...editForm.register('displayName')}
                />
              </FieldControl>
            </Field>
            <Field>
              <FieldLabel>{t('fieldRole')}</FieldLabel>
              <Select
                value={editForm.watch('role')}
                onValueChange={(v) => editForm.setValue('role', v as UserRole)}
              >
                <FieldControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FieldControl>
                <SelectContent>
                  <SelectItem value="user">{t('roleUser')}</SelectItem>
                  <SelectItem value="sysadmin">{t('roleSysadmin')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={editForm.formState.isSubmitting}>
                {editForm.formState.isSubmitting ? t('saving') : tc('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog */}
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('deleteUserTitle')}
        description={deleteError || t('deleteUserWarning')}
        onConfirm={onDeleteUser}
        isDeleting={isDeleting}
      />

      {/* Restore User Dialog */}
      <Dialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('restoreUserTitle')}</DialogTitle>
            <DialogDescription>{restoreError || t('restoreUserDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>
              {tc('cancel')}
            </Button>
            <Button onClick={onRestoreUser} disabled={isRestoring}>
              {isRestoring ? tc('loading') : t('restoreUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Purge User Dialog */}
      <DeleteConfirmDialog
        open={!!purgeTarget}
        onOpenChange={(open) => !open && setPurgeTarget(null)}
        title={t('purgeUserTitle')}
        description={purgeError || t('purgeUserWarning')}
        onConfirm={onPurgeUser}
        isDeleting={isPurging}
        confirmLabel={t('purgeUser')}
      />
    </div>
  )
}
