import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { GroupForm } from '@/components/dashboard/group/group-form'

export default async function NewGroupPage() {
  const t = await getTranslations('category')
  const tc = await getTranslations('common')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createCategory')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <GroupForm />
        </CardContent>
      </Card>
    </div>
  )
}
