'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dashboard/dataset/dataset-form'

interface Organization {
  id: string
  name: string
  title?: string
}

export default function NewDatasetPage() {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const [organizations, setOrganizations] = useState<Organization[]>([])

  useEffect(() => {
    clientFetch('/api/v1/users/me/organizations').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setOrganizations(data.items)
      }
    })
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('createDataset')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DatasetForm mode="create" organizations={organizations} />
        </CardContent>
      </Card>
    </div>
  )
}
