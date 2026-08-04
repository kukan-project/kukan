'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { rowActivateProps } from '@/lib/row-activate'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useMyRoles } from '@/hooks/use-my-roles'

interface GroupItem {
  id: string
  name: string
  title?: string
  datasetCount: number
}

export default function GroupsManagePage() {
  const user = useUser()
  const t = useTranslations('category')
  const tc = useTranslations('common')
  const router = useRouter()
  const { items, loading, error, ...pagination } = usePaginatedFetch<GroupItem>('/api/v1/groups')
  // The list covers every category; the actions are the viewer's own (#258)
  const { can } = useMyRoles('groups')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tc('categories')}>
        {/* Creating a category is sysadmin-only, same as organizations */}
        {user.sysadmin && (
          <Button asChild>
            <Link href="/dashboard/groups/new">{tc('new')}</Link>
          </Button>
        )}
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
        <p className="py-12 text-center text-muted-foreground">{t('noCategories')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc('urlIdentifier')}</TableHead>
                <TableHead>{tc('title')}</TableHead>
                <TableHead className="text-right">{tc('datasets')}</TableHead>
                <TableHead className="w-[80px] text-right">{tc('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((grp) => (
                <TableRow
                  key={grp.id}
                  // Only an admin has an editor to open, so only their row opens
                  // one (#258). Activating every row would take a viewer who
                  // cannot edit straight into the form they are not allowed to
                  // use — the thing this list was reported for.
                  {...(can(grp.name, 'admin')
                    ? rowActivateProps(() => router.push(`/dashboard/groups/${grp.name}/edit`))
                    : {})}
                >
                  <TableCell className="font-medium">{grp.name}</TableCell>
                  <TableCell>{grp.title || '-'}</TableCell>
                  <TableCell className="text-right">{grp.datasetCount}</TableCell>
                  <TableCell>
                    {/* Right-aligned so the trailing action lines up down the
                        column when a row offers fewer of them. The row click
                        opens the editor for those who have one; these nested
                        links act on their own. */}
                    <div className="flex justify-end gap-1">
                      {can(grp.name, 'member') && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/dashboard/groups/${grp.name}/members`}>
                            {tc('members')}
                          </Link>
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/group/${grp.name}`}>{tc('view')}</Link>
                      </Button>
                    </div>
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
