import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { getCurrentUser, serverFetch } from '@/lib/api'
import { PageHeader } from '@/components/dashboard/page-header'

export default async function OrganizationsManagePage() {
  const [user, orgRes] = await Promise.all([
    getCurrentUser(),
    serverFetch('/api/v1/organizations?limit=100'),
  ])
  if (!user) redirect('/auth/sign-in')
  const data = orgRes.ok ? await orgRes.json() : { items: [] }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="組織">
        {user.sysadmin && (
          <Button asChild>
            <Link href="/dashboard/organizations/new">新規作成</Link>
          </Button>
        )}
      </PageHeader>

      {data.items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">組織がありません</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>タイトル</TableHead>
              <TableHead className="text-right">データセット数</TableHead>
              <TableHead className="w-[80px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map(
              (org: { id: string; name: string; title?: string; datasetCount: number }) => (
                <TableRow key={org.id}>
                  <TableCell className="font-medium">{org.name}</TableCell>
                  <TableCell>{org.title || '-'}</TableCell>
                  <TableCell className="text-right">{org.datasetCount}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/organizations/${org.name}/members`}>メンバー</Link>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/organization/${org.name}`}>表示</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
