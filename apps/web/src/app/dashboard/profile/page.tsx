'use client'

import { Card, CardContent, CardHeader, CardTitle, Label } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'

export default function ProfilePage() {
  const user = useUser()
  const t = useTranslations('profile')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('accountInfo')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label className="text-muted-foreground">{t('username')}</Label>
            <p>{user.name}</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-muted-foreground">{t('displayName')}</Label>
            <p>{user.displayName || '-'}</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-muted-foreground">{t('email')}</Label>
            <p>{user.email}</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-muted-foreground">{t('role')}</Label>
            <p>{user.sysadmin ? t('sysadmin') : t('user')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
