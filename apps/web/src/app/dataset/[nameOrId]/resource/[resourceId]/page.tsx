import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Separator } from '@kukan/ui'
import { serverFetch, getCurrentUser } from '@/lib/server-api'
import { getFormatColorClass } from '@/lib/format-colors'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DateTime } from '@/components/date-time'
import { DownloadButton } from '@/components/download-button'
import { KeyValueTable, extrasToRows } from '@/components/key-value-table'
import { ResourcePipelinePreview } from '@/components/resource-pipeline-preview'

interface Resource {
  id: string
  packageId: string
  name?: string | null
  url?: string | null
  urlType?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
  hash?: string | null
  resourceType?: string | null
  created: string
  updated: string
  lastModified?: string | null
  extras?: Record<string, unknown> | null
}

interface Package {
  id: string
  name: string
  title?: string | null
  licenseId?: string | null
  ownerOrg?: string | null
}

interface Props {
  params: Promise<{ nameOrId: string; resourceId: string }>
}

export default async function ResourceDetailPage({ params }: Props) {
  const { nameOrId, resourceId } = await params

  // Fetch resource, package, user, orgs, and translations in parallel
  const [resRes, pkgRes, user, orgsRes, t, td] = await Promise.all([
    serverFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}`).catch(() => null),
    serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`).catch(() => null),
    getCurrentUser(),
    serverFetch('/api/v1/users/me/organizations').catch(() => null),
    getTranslations('resource'),
    getTranslations('dataset'),
  ])

  if (!resRes?.ok) notFound()

  const resource: Resource = await resRes.json()
  const pkg: Package | null = pkgRes?.ok ? await pkgRes.json() : null

  // Check if user can manage this resource (sysadmin or org member)
  let canManage = false
  if (user) {
    if (user.sysadmin) {
      canManage = true
    } else if (pkg?.ownerOrg && orgsRes?.ok) {
      const data = await orgsRes.json()
      canManage = data.items?.some((org: { id: string }) => org.id === pkg.ownerOrg)
    }
  }

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/dataset" className="hover:text-foreground">
            {td('breadcrumb')}
          </Link>
          <span>/</span>
          <Link href={`/dataset/${nameOrId}`} className="hover:text-foreground">
            {pkg?.title || pkg?.name || nameOrId}
          </Link>
          <span>/</span>
          <span className="text-foreground">{resource.name || t('unnamed')}</span>
        </nav>

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className={`mt-1 inline-flex min-w-[56px] items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase ${getFormatColorClass(resource.format)}`}
            >
              {resource.format || '?'}
            </span>
            <h1 className="text-3xl font-bold tracking-tight">{resource.name || t('unnamed')}</h1>
          </div>
          <DownloadButton
            datasetNameOrId={nameOrId}
            resourceId={resource.id}
            filename={resource.url || resource.id}
            label={t('download')}
          />
        </div>

        {resource.urlType === 'upload' && resource.url ? (
          <div>
            <a
              href={`/dataset/${encodeURIComponent(nameOrId)}/resource/${encodeURIComponent(resource.id)}/download/${encodeURIComponent(resource.url)}`}
              className="break-all text-sm text-primary underline-offset-4 hover:underline"
            >
              /dataset/{nameOrId}/resource/{resource.id}/download/{resource.url}
            </a>
          </div>
        ) : resource.url && resource.urlType !== 'upload' ? (
          <div>
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-sm text-primary underline-offset-4 hover:underline"
            >
              {resource.url}
            </a>
          </div>
        ) : null}

        {resource.description && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(resource.description)}
            </div>
          </>
        )}

        <Separator />
        <ResourcePipelinePreview
          resourceId={resource.id}
          format={resource.format}
          canManage={canManage}
        />

        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">{t('additionalInfo')}</h2>
          <KeyValueTable
            rows={[
              {
                label: t('lastModified'),
                value: resource.lastModified ? <DateTime value={resource.lastModified} /> : null,
              },
              { label: t('updated'), value: <DateTime value={resource.updated} /> },
              { label: t('created'), value: <DateTime value={resource.created} /> },
              { label: t('dataFormat'), value: resource.format?.toUpperCase() },
              { label: t('mimeType'), value: resource.mimetype },
              { label: t('size'), value: formatBytes(resource.size) },
              { label: t('resourceType'), value: resource.resourceType },
              { label: t('hash'), value: resource.hash },
              { label: t('license'), value: pkg?.licenseId },
              ...extrasToRows(resource.extras),
            ]}
          />
        </section>
      </div>
    </div>
  )
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
