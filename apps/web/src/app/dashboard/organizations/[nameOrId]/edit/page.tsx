'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { OrganizationForm } from '@/components/dashboard/organization/organization-form'
import { EntityDetails } from '@/components/dashboard/entity-details'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { useUser } from '@/components/dashboard/user-provider'
import { useMyRoles } from '@/hooks/use-my-roles'
import type { CreateOrganizationInput } from '@kukan/shared'

interface OrganizationDetail {
  id: string
  name: string
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  extras?: Record<string, unknown> | null
  datasetCount?: number
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
  const router = useRouter()
  const searchParams = useSearchParams()
  const user = useUser()
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const nameOrId = params.nameOrId as string
  const isDeleted = searchParams.get('state') === 'deleted'

  const [org, setOrg] = useState<OrganizationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { can, ready: rolesReady } = useMyRoles('organizations')
  const canEdit = can(nameOrId, 'admin')

  const fetchData = useCallback(async () => {
    // Reset to the loading state so a slower refetch (e.g. navigating between
    // orgs) never renders the previous org's data — otherwise the delete button
    // could briefly reflect a stale datasetCount and appear enabled.
    setLoading(true)
    setOrg(null)
    try {
      const url = isDeleted
        ? `/api/v1/organizations/${encodeURIComponent(nameOrId)}?state=deleted`
        : `/api/v1/organizations/${encodeURIComponent(nameOrId)}`
      const res = await clientFetch(url)
      setOrg(res.ok ? await res.json() : null)
    } finally {
      setLoading(false)
    }
  }, [nameOrId, isDeleted])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      const url = isDeleted
        ? `/api/v1/organizations/${encodeURIComponent(nameOrId)}/purge`
        : `/api/v1/organizations/${encodeURIComponent(nameOrId)}`
      const res = await clientFetch(url, { method: isDeleted ? 'POST' : 'DELETE' })
      if (res.ok) {
        // Soft-delete navigates to the deleted view of THIS same route, so the
        // component stays mounted — close the dialog explicitly or it would
        // re-render as the purge modal (isDeleted flips to true).
        setShowDelete(false)
        if (isDeleted) {
          router.push('/dashboard/organizations')
        } else {
          // Soft-deleted: move to the deleted view so restore/purge are reachable.
          router.push(`/dashboard/organizations/${nameOrId}/edit?state=deleted`)
        }
        return
      }
      // Surface the precondition error (e.g. active packages still linked).
      setError(t('deleteOrgError'))
      setShowDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  async function handleRestore() {
    setRestoring(true)
    try {
      const res = await clientFetch(
        `/api/v1/organizations/${encodeURIComponent(nameOrId)}/restore`,
        { method: 'POST' }
      )
      if (res.ok) router.push(`/dashboard/organizations/${nameOrId}/edit`)
    } finally {
      setRestoring(false)
    }
  }

  if (loading || !rolesReady) {
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

  // Soft-delete requires no active datasets; purge (on the deleted view) has no
  // such block since a deleted org can hold only trashed packages. Fail safe:
  // only allow delete when the count is positively known to be zero (an unknown
  // count must not enable a destructive action).
  const blockedByActiveDatasets = !isDeleted && org.datasetCount !== 0

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={canEdit ? t('editOrg') : t('manageTitle')} />

      {!isDeleted && (
        <Card>
          <CardHeader>
            <CardTitle>{tc('basicInfo')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {canEdit ? (
              <OrganizationForm
                mode="edit"
                nameOrId={nameOrId}
                defaultValues={toFormDefaults(org)}
              />
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{tc('viewOnlyNoAdmin')}</p>
                <EntityDetails
                  name={org.name}
                  title={org.title}
                  description={org.description}
                  imageUrl={org.imageUrl}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      {isDeleted && user.sysadmin && (
        <Card>
          <CardHeader>
            <CardTitle>{t('restoreOrg')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">{t('restoreOrgConfirm')}</p>
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? tc('loading') : t('restoreOrg')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Purge is sysadmin-only; soft-delete is available to org admins on the
          active page. A deleted org is absent from the viewer's memberships, so
          the purge branch stays on the sysadmin flag rather than the role. */}
      {(isDeleted ? user.sysadmin : canEdit) && (
        <Card className={isDeleted ? 'border-destructive/30' : 'border-warning/40'}>
          <CardHeader>
            <CardTitle className={isDeleted ? 'text-destructive' : 'text-warning-tint-foreground'}>
              {isDeleted ? t('dangerZone') : t('deleteOrg')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              {isDeleted ? t('purgeOrgConfirm') : t('deleteOrgConfirm')}
            </p>
            {/* Soft-delete is blocked while active datasets remain (server enforces
                the same guard); disable the button proactively and explain why. */}
            {blockedByActiveDatasets && !!org.datasetCount && (
              <p className="mb-3 text-sm text-destructive">
                {t('deleteOrgBlocked', { count: org.datasetCount })}
              </p>
            )}
            {error && (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              variant={isDeleted ? 'destructive' : 'outline'}
              onClick={() => setShowDelete(true)}
              disabled={blockedByActiveDatasets}
            >
              {isDeleted ? t('purgeOrg') : t('deleteOrg')}
            </Button>
          </CardContent>
        </Card>
      )}

      <DeleteConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title={isDeleted ? t('purgeOrg') : t('deleteOrg')}
        description={isDeleted ? t('purgeOrgConfirm') : t('deleteOrgConfirm')}
        onConfirm={handleDelete}
        isDeleting={deleting}
        confirmLabel={isDeleted ? t('purgeOrg') : undefined}
      />
    </div>
  )
}
