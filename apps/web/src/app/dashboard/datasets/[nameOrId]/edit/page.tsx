'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { isDraftPlaceholderName, type PackageState } from '@kukan/shared'
import { Sparkles } from 'lucide-react'
import { clientFetch } from '@/lib/client-api'
import { useFetch } from '@/hooks/use-fetch'
import { hasRole } from '@/hooks/use-my-roles'
import type { PipelineStatus } from '@/hooks/use-pipeline-status'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { PageHeader } from '@/components/dashboard/page-header'
import { DatasetForm } from '@/components/dashboard/dataset/dataset-form'
import { PublishSyncBanner } from '@/components/dashboard/dataset/publish-sync-banner'
import { ViewPublicLink } from '@/components/dashboard/view-public-link'
import { ResourceList } from '@/components/dashboard/dataset/resource-list'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'
import { Button } from '@kukan/ui'

interface Organization {
  id: string
  name: string
  title?: string
  role?: string
}

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  format?: string | null
  description?: string | null
  pipelineStatus?: PipelineStatus | null
  latestVersion?: number | null
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
  state: PackageState
  type?: string | null
  extras?: Record<string, unknown> | null
  tags?: { id: string; name: string }[]
  groups?: { id: string; name: string; title?: string | null }[]
  resources?: Resource[]
  organization?: { id: string; name: string; title?: string | null } | null
}

/** What the page holds once loaded. `resources` is settled at the fetch rather
 *  than at each use: `?? []` in the markup hands a new array identity down on
 *  every render, which costs the resource list a render it cannot use. */
type LoadedPackage = PackageDetail & { resources: Resource[] }

/** Stands in for the resources of a package that has not loaded yet, so that
 *  standing in does not itself produce a new array each render. */
const EMPTY_RESOURCES: Resource[] = []

/** API response → form defaults */
function toFormDefaults(pkg: PackageDetail) {
  return {
    // Never expose the auto-generated draft placeholder name (ADR-039)
    name: isDraftPlaceholderName(pkg.name) ? '' : pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    url: pkg.url ?? undefined,
    version: pkg.version ?? undefined,
    licenseId: pkg.licenseId ?? undefined,
    author: pkg.author ?? undefined,
    authorEmail: pkg.authorEmail ?? undefined,
    maintainer: pkg.maintainer ?? undefined,
    maintainerEmail: pkg.maintainerEmail ?? undefined,
    ownerOrg: pkg.ownerOrg ?? undefined,
    private: pkg.private,
    type: pkg.type ?? 'dataset',
    extras: (pkg.extras as Record<string, unknown>) ?? {},
    tags: pkg.tags?.map((t) => ({ name: t.name })) ?? [],
    groups: pkg.groups?.map((g) => ({ name: g.name })) ?? [],
  }
}

export default function EditDatasetPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const nameOrId = params.nameOrId as string
  const stateParam = searchParams.get('state')
  const isDeleted = stateParam === 'deleted'

  const [pkg, setPkg] = useState<LoadedPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [syncWarning, setSyncWarning] = useState(false)
  const [published, setPublished] = useState(false)
  // Ref twin of `published` for stale fetchData closures (state would lag)
  const publishedRef = useRef(false)

  // AI metadata suggestions (ADR-040): capability flag, pipeline-complete
  // nudge, and a counter that opens the dialog inside DatasetForm
  const { metadataSuggestEnabled, metadataSuggestLocalModel } = useSiteSettings()
  const [suggestNudge, setSuggestNudge] = useState(false)
  const [suggestOpenSignal, setSuggestOpenSignal] = useState(0)
  const [uploading, setUploading] = useState(false)

  // Concurrent refetches (upload completions, pipeline settles) can resolve
  // out of order — apply monotonically so a slow stale response can't roll
  // fresh pipeline statuses back
  const fetchSeq = useRef(0)
  const appliedSeq = useRef(0)
  /** Refetch the package; false = this refresh failed (callers may retry) */
  const fetchData = useCallback(async (): Promise<boolean> => {
    const seq = ++fetchSeq.current
    const apply = (data: PackageDetail) => {
      if (seq > appliedSeq.current) {
        appliedSeq.current = seq
        setPkg({ ...data, resources: data.resources ?? [] })
      }
    }
    try {
      const stateQuery =
        stateParam === 'deleted' || stateParam === 'draft' ? `?state=${stateParam}` : ''
      const pkgRes = await clientFetch(`/api/v1/packages/${nameOrId}${stateQuery}`)
      if (pkgRes.ok) {
        apply(await pkgRes.json())
      } else if (!stateQuery) {
        // A draft opened without ?state=draft 404s on the active path — retry as draft
        const draftRes = await clientFetch(`/api/v1/packages/${nameOrId}?state=draft`)
        if (!draftRes.ok) return false
        apply(await draftRes.json())
      } else if (stateParam === 'draft') {
        // ?state=draft but the package is already active: publish committed but the
        // follow-up search sync may have failed — offer the idempotent re-publish.
        // Not when this session already published: a pre-publish refetch firing
        // late must not resurrect the warning
        const activeRes = await clientFetch(`/api/v1/packages/${nameOrId}`)
        if (!activeRes.ok) return false
        apply(await activeRes.json())
        if (!publishedRef.current) {
          setSyncWarning(true)
          router.replace(`/dashboard/datasets/${nameOrId}/edit`)
        }
      } else {
        return false
      }
      return true
    } catch {
      return false
    } finally {
      setLoading(false)
    }
  }, [nameOrId, stateParam, router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // The org options never change with the package — fetch once on mount
  const { data: orgData } = useFetch<{ items: Organization[] }>('/api/v1/users/me/organizations')
  // Only organizations the viewer may write in
  const organizations = (orgData?.items ?? []).filter((o) => hasRole(o.role, 'editor'))

  const isDraft = pkg?.state === 'draft'

  // Offer suggestions only once every resource settled — a mid-upload
  // resource has no pipeline status yet, so uploads must count as busy too
  const resources = pkg?.resources ?? EMPTY_RESOURCES
  const resourcesBusy =
    uploading ||
    resources.some((r) => r.pipelineStatus === 'queued' || r.pipelineStatus === 'processing')
  const hasCompleteResource = resources.some((r) => r.pipelineStatus === 'complete')

  // Nudge only on a busy → idle transition, never on initial load — and only
  // when something completed, matching the button's complete >= 1 condition
  const wasBusyRef = useRef(false)
  useEffect(() => {
    if (resourcesBusy) {
      wasBusyRef.current = true
      // Retract a lingering invitation — it would miss the new resources
      setSuggestNudge(false)
      return
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false
      if (hasCompleteResource) setSuggestNudge(true)
    }
  }, [resourcesBusy, hasCompleteResource])

  const handlePublished = useCallback(() => {
    // A successful publish always lands on 'active', and re-enqueued the
    // pipeline of every url resource before responding — mirror the queued
    // statuses so the suggest gate closes until the badges see them settle
    setPkg((prev) =>
      prev
        ? {
            ...prev,
            state: 'active',
            resources: prev.resources.map((r) =>
              r.url ? { ...r, pipelineStatus: 'queued' as const } : r
            ),
          }
        : prev
    )
    setSyncWarning(false)
    setPublished(true)
    publishedRef.current = true
    // Now active: drop ?state=draft so the refetch hits the active path
    router.replace(`/dashboard/datasets/${nameOrId}/edit`)
  }, [nameOrId, router])

  async function handleDelete() {
    setDeleting(true)
    try {
      const url = isDeleted ? `/api/v1/packages/${nameOrId}/purge` : `/api/v1/packages/${nameOrId}`
      const method = isDeleted ? 'POST' : 'DELETE'
      const res = await clientFetch(url, { method })
      if (res.ok) {
        router.push('/dashboard/datasets')
      }
    } finally {
      setDeleting(false)
    }
  }

  const [restoring, setRestoring] = useState(false)
  const [restorePrivate, setRestorePrivate] = useState(false)

  async function handleRestore() {
    setRestoring(true)
    try {
      // Only when asked — a plain restore keeps the visibility it was deleted with
      const res = await clientFetch(`/api/v1/packages/${nameOrId}/restore`, {
        method: 'POST',
        ...(restorePrivate && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ private: true }),
        }),
      })
      if (res.ok) {
        router.push(`/dashboard/datasets/${nameOrId}/edit`)
      }
    } finally {
      setRestoring(false)
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

  // A draft is unpublished and carries a placeholder name, and a deleted dataset
  // is gone from the site — neither has a public page to link to
  const publicName = isDraft || isDeleted ? undefined : pkg.name

  // Delete section wording/styling (deleted > draft > active precedence)
  const deleteConfirmText = isDraft ? t('deleteDraftConfirm') : t('deleteDatasetConfirm')
  const deleteUi = isDeleted
    ? {
        cardClass: 'border-destructive/30',
        titleClass: 'text-destructive',
        title: t('dangerZone'),
        description: null,
        buttonVariant: 'destructive' as const,
        buttonLabel: t('purgeDataset'),
        dialogTitle: t('purgeDataset'),
        dialogDescription: t('purgeDatasetConfirm'),
        confirmLabel: t('purgeDataset'),
      }
    : {
        cardClass: 'border-warning/40',
        titleClass: 'text-warning-tint-foreground',
        title: isDraft ? t('deleteDraft') : t('deleteDataset'),
        description: deleteConfirmText,
        buttonVariant: 'outline' as const,
        // The button names its target ("this dataset"); headings stay generic
        buttonLabel: isDraft ? t('deleteDraft') : t('deleteThisDataset'),
        dialogTitle: isDraft ? t('deleteDraft') : t('deleteDataset'),
        dialogDescription: deleteConfirmText,
        confirmLabel: isDraft ? t('purgeDataset') : undefined,
      }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('editDataset')}>
        {isDraft && <Badge variant="secondary">{t('draftBadge')}</Badge>}
        {publicName && (
          <ViewPublicLink href={`/dataset/${publicName}`} variant="outline" size="default" />
        )}
      </PageHeader>

      {published && (
        <Alert variant="success" role="status">
          <AlertDescription>
            <p>
              {t('publishSuccess')}{' '}
              <Link href={`/dataset/${pkg.name}`} className="font-medium underline">
                {t('viewPublished')}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      {syncWarning && <PublishSyncBanner nameOrId={nameOrId} onPublished={handlePublished} />}

      {suggestNudge && metadataSuggestEnabled === true && !isDeleted && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <span className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            {t('aiSuggestNudge')}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setSuggestNudge(false)
                setSuggestOpenSignal((n) => n + 1)
              }}
            >
              {t('aiSuggestNudgeButton')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSuggestNudge(false)}>
              {tc('cancel')}
            </Button>
          </div>
        </div>
      )}

      {isDeleted ? (
        <>
          <Card className="opacity-70">
            <CardHeader>
              <CardTitle>{tc('basicInfo')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="font-medium text-muted-foreground">{tc('name')}: </span>
                {pkg.name}
              </div>
              {pkg.title && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('title')}: </span>
                  {pkg.title}
                </div>
              )}
              {pkg.notes && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('description')}: </span>
                  {pkg.notes}
                </div>
              )}
              {pkg.organization && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('organization')}: </span>
                  {pkg.organization.title || pkg.organization.name}
                </div>
              )}
              {pkg.licenseId && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('license')}: </span>
                  {pkg.licenseId}
                </div>
              )}
              {pkg.tags && pkg.tags.length > 0 && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('tags')}: </span>
                  {pkg.tags.map((tag: { name: string }) => tag.name).join(', ')}
                </div>
              )}
              <div>
                <span className="font-medium text-muted-foreground">
                  {pkg.private ? tc('private') : tc('public')}
                </span>
              </div>
              {pkg.author && (
                <div>
                  <span className="font-medium text-muted-foreground">{tc('author')}: </span>
                  {pkg.author}
                </div>
              )}
            </CardContent>
          </Card>

          {pkg.resources.length > 0 && (
            <Card className="opacity-60">
              <CardHeader>
                <CardTitle>{t('resources')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {pkg.resources.map(
                    (r: { id: string; name?: string | null; format?: string | null }) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <span>{r.name || r.id}</span>
                        {r.format && (
                          <span className="text-xs text-muted-foreground">{r.format}</span>
                        )}
                      </li>
                    )
                  )}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{tc('basicInfo')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DatasetForm
                key={pkg.state}
                mode="edit"
                nameOrId={nameOrId}
                defaultValues={toFormDefaults(pkg)}
                organizations={organizations}
                isDraft={isDraft}
                // Full refetch (not the PUT response) keeps tags/groups fresh
                // so the publish-time remount doesn't restore stale defaults
                onSaved={isDraft ? fetchData : undefined}
                onPublished={isDraft ? handlePublished : undefined}
                suggest={{
                  enabled: metadataSuggestEnabled,
                  localModel: metadataSuggestLocalModel,
                  resources: pkg.resources,
                  processing: resourcesBusy,
                  openSignal: suggestOpenSignal,
                  onResourcesUpdated: fetchData,
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('resources')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ResourceList
                packageId={pkg.id}
                packageName={publicName}
                resources={pkg.resources}
                onUpdated={fetchData}
                onUploadingChange={setUploading}
              />
            </CardContent>
          </Card>
        </>
      )}

      {isDeleted && (
        <Card>
          <CardHeader>
            <CardTitle>{t('restoreDataset')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">{t('restoreDatasetConfirm')}</p>
            {/* A dataset that was private is already off the site */}
            {!pkg.private && (
              <div className="mb-4 flex items-center gap-2">
                <Switch
                  id="restore-private"
                  checked={restorePrivate}
                  onCheckedChange={setRestorePrivate}
                />
                <Label htmlFor="restore-private" className="cursor-pointer font-normal">
                  {t('restoreAsPrivate')}
                </Label>
              </div>
            )}
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? tc('loading') : t('restoreDataset')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className={deleteUi.cardClass}>
        <CardHeader>
          <CardTitle className={deleteUi.titleClass}>{deleteUi.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {deleteUi.description && (
            <p className="mb-3 text-sm text-muted-foreground">{deleteUi.description}</p>
          )}
          <Button variant={deleteUi.buttonVariant} onClick={() => setShowDelete(true)}>
            {deleteUi.buttonLabel}
          </Button>
        </CardContent>
      </Card>

      <DeleteConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title={deleteUi.dialogTitle}
        description={deleteUi.dialogDescription}
        onConfirm={handleDelete}
        isDeleting={deleting}
        confirmLabel={deleteUi.confirmLabel}
      />
    </div>
  )
}
