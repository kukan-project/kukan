import { serverFetch } from '@/lib/api'

export default async function DashboardPage() {
  const res = await serverFetch('/api/v1/users/me')
  const user = await res.json()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">ダッシュボード</h1>
      <p className="text-muted-foreground">ようこそ、{user.name} さん</p>
    </div>
  )
}
