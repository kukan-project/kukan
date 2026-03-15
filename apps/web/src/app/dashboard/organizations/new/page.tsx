import { redirect } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { getCurrentUser } from '@/lib/api'
import { PageHeader } from '@/components/dashboard/page-header'
import { OrganizationForm } from '@/components/organization/organization-form'

export default async function NewOrganizationPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/sign-in')
  if (!user.sysadmin) redirect('/dashboard/organizations')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="組織を作成" />
      <Card>
        <CardHeader>
          <CardTitle>基本情報</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationForm />
        </CardContent>
      </Card>
    </div>
  )
}
