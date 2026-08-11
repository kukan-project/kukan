'use client'

import { Card, CardContent, CardHeader, CardTitle, Field, FieldTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { PasswordChangeCard } from '@/components/dashboard/password-change-card'

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
          <Field className="gap-1">
            <FieldTitle className="text-muted-foreground">{t('username')}</FieldTitle>
            <p>{user.name}</p>
          </Field>
          <Field className="gap-1">
            <FieldTitle className="text-muted-foreground">{t('displayName')}</FieldTitle>
            <p>{user.displayName || '-'}</p>
          </Field>
          <Field className="gap-1">
            <FieldTitle className="text-muted-foreground">{t('email')}</FieldTitle>
            <p>{user.email}</p>
          </Field>
          <Field className="gap-1">
            <FieldTitle className="text-muted-foreground">{t('role')}</FieldTitle>
            <p>{user.sysadmin ? t('sysadmin') : t('user')}</p>
          </Field>
        </CardContent>
      </Card>
      <PasswordChangeCard />
    </div>
  )
}
