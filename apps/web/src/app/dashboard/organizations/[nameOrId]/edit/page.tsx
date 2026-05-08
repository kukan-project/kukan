'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { OrganizationForm } from '@/components/dashboard/organization/organization-form'
import type { CreateOrganizationInput } from '@kukan/shared'

interface OrganizationDetail {
  id: string
  name: string
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  extras?: Record<string, unknown> | null
}

function toFormDefaults(org: OrganizationDetail): Partial<CreateOrganizationInput> {
  return {
    name: org.name,
    title: org.title ?? undefined,
    description: org.description ?? undefined,
    imageUrl: org.imageUrl ?? undefined,
    extras: (org.extras as Record<string, unknown>) ?? {},
  }
}

export default function EditOrganizationPage() {
  const params = useParams()
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const nameOrId = params.nameOrId as string

  const [org, setOrg] = useState<OrganizationDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const res = await clientFetch(`/api/v1/organizations/${encodeURIComponent(nameOrId)}`)
      if (res.ok) setOrg(await res.json())
    } finally {
      setLoading(false)
    }
  }, [nameOrId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editOrg')} />
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  if (!org) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editOrg')} />
        <p className="py-12 text-center text-muted-foreground">{tc('notFound')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('editOrg')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationForm mode="edit" nameOrId={nameOrId} defaultValues={toFormDefaults(org)} />
        </CardContent>
      </Card>
    </div>
  )
}
