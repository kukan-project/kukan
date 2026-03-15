'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { OrganizationForm } from '@/components/dashboard/organization/organization-form'

export default function NewOrganizationPage() {
  const user = useUser()
  const router = useRouter()

  useEffect(() => {
    if (!user.sysadmin) router.replace('/dashboard/organizations')
  }, [user.sysadmin, router])

  if (!user.sysadmin) return null

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
