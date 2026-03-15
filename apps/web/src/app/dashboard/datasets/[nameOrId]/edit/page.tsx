'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dashboard/dataset/dataset-form'
import { ResourceList } from '@/components/dashboard/dataset/resource-list'
import { ResourceForm } from '@/components/dashboard/dataset/resource-form'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { Button } from '@kukan/ui'
import type { CreatePackageInput } from '@kukan/shared'

interface Organization {
  id: string
  name: string
  title?: string
}

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  format?: string | null
  description?: string | null
}

interface PackageDetail {
  id: string
  name: string
  title?: string | null
  notes?: string | null
  url?: string | null
  version?: string | null
  licenseId?: string | null
  author?: string | null
  authorEmail?: string | null
  maintainer?: string | null
  maintainerEmail?: string | null
  ownerOrg?: string | null
  private: boolean
  type?: string | null
  extras?: Record<string, unknown> | null
  tags?: { id: string; name: string }[]
  resources?: Resource[]
}

/** API response (camelCase) → form defaults (snake_case) */
function toFormDefaults(pkg: PackageDetail): Partial<CreatePackageInput> {
  return {
    name: pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    url: pkg.url ?? undefined,
    version: pkg.version ?? undefined,
    license_id: pkg.licenseId ?? undefined,
    author: pkg.author ?? undefined,
    author_email: pkg.authorEmail ?? undefined,
    maintainer: pkg.maintainer ?? undefined,
    maintainer_email: pkg.maintainerEmail ?? undefined,
    owner_org: pkg.ownerOrg ?? undefined,
    private: pkg.private,
    type: pkg.type ?? 'dataset',
    extras: (pkg.extras as Record<string, unknown>) ?? {},
    tags: pkg.tags?.map((t) => ({ name: t.name })) ?? [],
    resources: [],
  }
}

export default function EditDatasetPage() {
  const params = useParams()
  const router = useRouter()
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const nameOrId = params.nameOrId as string

  const [pkg, setPkg] = useState<PackageDetail | null>(null)
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const fetchData = useCallback(async () => {
    const [pkgRes, orgRes] = await Promise.all([
      clientFetch(`/api/v1/packages/${nameOrId}`),
      clientFetch('/api/v1/users/me/organizations'),
    ])
    if (pkgRes.ok) setPkg(await pkgRes.json())
    if (orgRes.ok) {
      const data = await orgRes.json()
      setOrganizations(data.items)
    }
    setLoading(false)
  }, [nameOrId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await clientFetch(`/api/v1/packages/${nameOrId}`, { method: 'DELETE' })
      if (res.ok) {
        router.push('/dashboard/datasets')
      }
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editDataset')} />
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  if (!pkg) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('editDataset')} />
        <p className="py-12 text-center text-muted-foreground">{t('notFound')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('editDataset')} />

      <Card>
        <CardHeader>
          <CardTitle>{tc('basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DatasetForm
            mode="edit"
            nameOrId={nameOrId}
            defaultValues={toFormDefaults(pkg)}
            organizations={organizations}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('resources')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResourceList resources={pkg.resources ?? []} onDeleted={fetchData} />
          <ResourceForm packageId={pkg.id} onCreated={fetchData} />
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">{t('dangerZone')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setShowDelete(true)}>
            {t('deleteDataset')}
          </Button>
        </CardContent>
      </Card>

      <DeleteConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title={t('deleteDataset')}
        description={t('deleteDatasetConfirm')}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </div>
  )
}
