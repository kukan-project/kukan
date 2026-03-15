import Link from 'next/link'
import { redirect } from 'next/navigation'
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
import { getCurrentUser, serverFetch } from '@/lib/api'
import { PageHeader } from '@/components/dashboard/page-header'

export default async function DatasetsManagePage() {
  const [user, res] = await Promise.all([
    getCurrentUser(),
    serverFetch('/api/v1/packages?my_org=true&limit=100'),
  ])
  if (!user) redirect('/auth/sign-in')
  const data = res.ok ? await res.json() : { items: [] }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="データセット">
        <Button asChild>
          <Link href="/dashboard/datasets/new">新規作成</Link>
        </Button>
      </PageHeader>

      {data.items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">データセットがありません</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>タイトル</TableHead>
              <TableHead>公開状態</TableHead>
              <TableHead>フォーマット</TableHead>
              <TableHead className="w-[80px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map(
              (pkg: {
                id: string
                name: string
                title?: string | null
                private: boolean
                formats?: string
              }) => (
                <TableRow key={pkg.id}>
                  <TableCell className="font-medium">{pkg.title || pkg.name}</TableCell>
                  <TableCell>
                    {pkg.private ? <Badge variant="secondary">非公開</Badge> : <Badge>公開</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {pkg.formats
                        ? pkg.formats
                            .split(',')
                            .filter(Boolean)
                            .map((f: string) => (
                              <Badge key={f} variant="outline">
                                {f}
                              </Badge>
                            ))
                        : '-'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/datasets/${pkg.name}/edit`}>編集</Link>
                    </Button>
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
