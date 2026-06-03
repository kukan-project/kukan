'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { AnnouncementForm } from '@/components/dashboard/announcement/announcement-form'
import type { CreateAnnouncementInput } from '@kukan/shared'

interface AnnouncementDetail {
  id: string
  title: string
  category: string
  link?: string | null
  publishedAt?: string | null
}

function toFormDefaults(item: AnnouncementDetail): Partial<CreateAnnouncementInput> {
  return {
    title: item.title,
    category: item.category as CreateAnnouncementInput['category'],
    link: item.link ?? undefined,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
  }
}

export default function EditAnnouncementPage() {
  const params = useParams()
  const t = useTranslations('announcement')
  const tc = useTranslations('common')
  const id = params.id as string

  const [item, setItem] = useState<AnnouncementDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const res = await clientFetch(`/api/v1/announcements/${encodeURIComponent(id)}`)
      if (res.ok) setItem(await res.json())
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editAnnouncement')} />
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editAnnouncement')} />
        <p className="py-12 text-center text-muted-foreground">{tc('notFound')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('editAnnouncement')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AnnouncementForm mode="edit" id={id} defaultValues={toFormDefaults(item)} />
        </CardContent>
      </Card>
    </div>
  )
}
