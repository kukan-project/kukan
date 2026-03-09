import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { GroupForm } from '@/components/group/group-form'

export default function NewGroupPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="グループを作成" />
      <Card>
        <CardHeader>
          <CardTitle>基本情報</CardTitle>
        </CardHeader>
        <CardContent>
          <GroupForm />
        </CardContent>
      </Card>
    </div>
  )
}
