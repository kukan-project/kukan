import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { serverFetch } from '@/lib/api'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dataset/dataset-form'

export default async function NewDatasetPage() {
  const res = await serverFetch('/api/v1/users/me/organizations')
  const data = res.ok ? await res.json() : { items: [] }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="データセットを作成" />
      <Card>
        <CardHeader>
          <CardTitle>基本情報</CardTitle>
        </CardHeader>
        <CardContent>
          <DatasetForm mode="create" organizations={data.items} />
        </CardContent>
      </Card>
    </div>
  )
}
