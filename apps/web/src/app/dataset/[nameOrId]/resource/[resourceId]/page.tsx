import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { getFormatColorClass } from '@/lib/format-colors'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DateTime } from '@/components/date-time'

interface Resource {
  id: string
  packageId: string
  name?: string | null
  url?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
  hash?: string | null
  resourceType?: string | null
  created: string
  updated: string
  lastModified?: string | null
}

interface Package {
  id: string
  name: string
  title?: string | null
  licenseId?: string | null
}

interface Props {
  params: Promise<{ nameOrId: string; resourceId: string }>
}

export default async function ResourceDetailPage({ params }: Props) {
  const { nameOrId, resourceId } = await params

  // Fetch resource, package, and translations in parallel
  const [resRes, pkgRes, t, td] = await Promise.all([
    serverFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}`).catch(() => null),
    serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`).catch(() => null),
    getTranslations('resource'),
    getTranslations('dataset'),
  ])

  if (!resRes?.ok) notFound()

  const resource: Resource = await resRes.json()
  const pkg: Package | null = pkgRes?.ok ? await pkgRes.json() : null

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

        <div className="flex items-start gap-3">
          <span
            className={`mt-1 inline-flex min-w-[56px] items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase ${getFormatColorClass(resource.format)}`}
          >
            {resource.format || '?'}
          </span>
          <h1 className="text-3xl font-bold tracking-tight">{resource.name || t('unnamed')}</h1>
        </div>

        {resource.url && (
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
        )}

        {resource.description && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(resource.description)}
            </div>
          </>
        )}

        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">{t('preview')}</h2>
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t('previewPlaceholder')}
            </CardContent>
          </Card>
        </section>

        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">{t('additionalInfo')}</h2>
          <ResourceMetadataTable
            resource={resource}
            licenseId={pkg?.licenseId}
            labels={{
              lastModified: t('lastModified'),
              metadataModified: t('metadataModified'),
              created: t('created'),
              dataFormat: t('dataFormat'),
              mimeType: t('mimeType'),
              size: t('size'),
              resourceType: t('resourceType'),
              hash: t('hash'),
              license: t('license'),
            }}
          />
        </section>
      </div>
    </div>
  )
}

function ResourceMetadataTable({
  resource,
  licenseId,
  labels,
}: {
  resource: Resource
  licenseId?: string | null
  labels: Record<string, string>
}) {
  const rows = [
    {
      label: labels.lastModified,
      value:
        resource.lastModified || resource.updated ? (
          <DateTime value={resource.lastModified || resource.updated} />
        ) : null,
    },
    {
      label: labels.metadataModified,
      value: <DateTime value={resource.updated} />,
    },
    {
      label: labels.created,
      value: <DateTime value={resource.created} />,
    },
    { label: labels.dataFormat, value: resource.format?.toUpperCase() },
    { label: labels.mimeType, value: resource.mimetype },
    { label: labels.size, value: formatBytes(resource.size) },
    { label: labels.resourceType, value: resource.resourceType },
    { label: labels.hash, value: resource.hash },
    { label: labels.license, value: licenseId },
  ].filter((row) => row.value)

  if (rows.length === 0) return null

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full">
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.label} className={i % 2 === 0 ? 'bg-muted/50' : ''}>
              <th className="w-1/3 px-4 py-3 text-left text-sm font-medium">{row.label}</th>
              <td className="px-4 py-3 text-sm">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
