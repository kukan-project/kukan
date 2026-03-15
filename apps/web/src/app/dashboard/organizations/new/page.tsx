'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { OrganizationForm } from '@/components/dashboard/organization/organization-form'

export default function NewOrganizationPage() {
  const user = useUser()
  const router = useRouter()
  const t = useTranslations('organization')
  const tc = useTranslations('common')

  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard/organizations')
  }, [user.sysadmin, router])

  if (!user.sysadmin) return null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createOrg')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationForm />
        </CardContent>
      </Card>
    </div>
  )
}
