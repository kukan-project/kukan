import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { PageHeader } from '@/components/dashboard/page-header'
import { AnnouncementForm } from '@/components/dashboard/announcement/announcement-form'

export default async function NewAnnouncementPage() {
  const t = await getTranslations('announcement')
  const tc = await getTranslations('common')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createAnnouncement')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AnnouncementForm />
        </CardContent>
      </Card>
    </div>
  )
}
