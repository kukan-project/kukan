import Link from 'next/link'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { serverFetch } from '@/lib/api'
import { PageHeader } from '@/components/dashboard/page-header'

export default async function GroupsManagePage() {
  const res = await serverFetch('/api/v1/groups?limit=100')
  const data = res.ok ? await res.json() : { items: [] }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="グループ">
        <Button asChild>
          <Link href="/dashboard/groups/new">新規作成</Link>
        </Button>
      </PageHeader>

      {data.items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">グループがありません</p>
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
              (grp: { id: string; name: string; title?: string; datasetCount: number }) => (
                <TableRow key={grp.id}>
                  <TableCell className="font-medium">{grp.name}</TableCell>
                  <TableCell>{grp.title || '-'}</TableCell>
                  <TableCell className="text-right">{grp.datasetCount}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/groups/${grp.name}/members`}>メンバー</Link>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/group/${grp.name}`}>表示</Link>
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
