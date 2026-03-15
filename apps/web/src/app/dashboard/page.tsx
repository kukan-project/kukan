import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '@kukan/ui'
import { getCurrentUser, serverFetch } from '@/lib/api'

export default async function DashboardPage() {
  const [user, pkgRes] = await Promise.all([
    getCurrentUser(),
    serverFetch('/api/v1/packages?my_org=true&limit=5'),
  ])
  if (!user) redirect('/auth/sign-in')
  const pkgData = pkgRes.ok ? await pkgRes.json() : { items: [], total: 0 }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ダッシュボード</h1>
        <p className="text-muted-foreground">ようこそ、{user.name} さん</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              データセット数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{pkgData.total}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>最近のデータセット</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/datasets">すべて表示</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {pkgData.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <p className="text-muted-foreground">データセットがありません</p>
              <Button asChild>
                <Link href="/dashboard/datasets/new">データセットを作成</Link>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col divide-y">
              {pkgData.items.map(
                (pkg: {
                  id: string
                  name: string
                  title?: string | null
                  private: boolean
                  formats?: string
                }) => (
                  <div key={pkg.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/dashboard/datasets/${pkg.name}/edit`}
                        className="font-medium hover:underline"
                      >
                        {pkg.title || pkg.name}
                      </Link>
                      {pkg.private && <Badge variant="secondary">非公開</Badge>}
                    </div>
                    <div className="flex gap-1">
                      {pkg.formats
                        ?.split(',')
                        .filter(Boolean)
                        .map((f: string) => (
                          <Badge key={f} variant="outline">
                            {f}
                          </Badge>
                        ))}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
