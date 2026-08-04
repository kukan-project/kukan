'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { GroupForm } from '@/components/dashboard/group/group-form'
import { EntityDetails } from '@/components/dashboard/entity-details'
import { useMyRoles } from '@/hooks/use-my-roles'
import type { CreateGroupInput } from '@kukan/shared'

interface GroupDetail {
  id: string
  name: string
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  extras?: Record<string, unknown> | null
}

function toFormDefaults(grp: GroupDetail): Partial<CreateGroupInput> {
  return {
    name: grp.name,
    title: grp.title ?? undefined,
    description: grp.description ?? undefined,
    imageUrl: grp.imageUrl ?? undefined,
    extras: (grp.extras as Record<string, unknown>) ?? {},
  }
}

export default function EditGroupPage() {
  const params = useParams()
  const t = useTranslations('category')
  const tc = useTranslations('common')
  const nameOrId = params.nameOrId as string

  const [grp, setGrp] = useState<GroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const { can, ready: rolesReady } = useMyRoles('groups')
  const canEdit = can(nameOrId, 'admin')

  const fetchData = useCallback(async () => {
    try {
      const res = await clientFetch(`/api/v1/groups/${encodeURIComponent(nameOrId)}`)
      if (res.ok) setGrp(await res.json())
    } finally {
      setLoading(false)
    }
  }, [nameOrId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading || !rolesReady) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editCategory')} />
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  if (!grp) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editCategory')} />
        <p className="py-12 text-center text-muted-foreground">{tc('notFound')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={canEdit ? t('editCategory') : tc('categories')} />
      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canEdit ? (
            <GroupForm mode="edit" nameOrId={nameOrId} defaultValues={toFormDefaults(grp)} />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{tc('viewOnlyNoAdmin')}</p>
              <EntityDetails
                name={grp.name}
                title={grp.title}
                description={grp.description}
                imageUrl={grp.imageUrl}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
