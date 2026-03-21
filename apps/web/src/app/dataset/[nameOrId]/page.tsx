import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Building2, FolderOpen, Tag } from 'lucide-react'
import { Badge, Card, CardContent, Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { getFormatColorClass } from '@/lib/format-colors'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DateTime } from '@/components/date-time'
import { DownloadButton } from '@/components/download-button'
import { KeyValueTable, extrasToRows } from '@/components/key-value-table'

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
}

interface Organization {
  id: string
  name: string
  title?: string | null
}

interface Package {
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
  private: boolean
  created: string
  updated: string
  extras?: Record<string, unknown> | null
  resources: Resource[]
  tags: { id: string; name: string }[]
  groups: { id: string; name: string; title?: string | null }[]
  organization: Organization | null
}

interface Props {
  params: Promise<{ nameOrId: string }>
}

export default async function DatasetDetailPage({ params }: Props) {
  const { nameOrId } = await params

  let res: Response
  try {
    res = await serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`)
  } catch {
    notFound()
  }

  if (!res.ok) {
    notFound()
  }

  const [pkg, t, tr] = await Promise.all([
    res.json() as Promise<Package>,
    getTranslations('dataset'),
    getTranslations('resource'),
  ])

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/dataset" className="hover:text-foreground">
            {t('breadcrumb')}
          </Link>
          <span>/</span>
          <span className="text-foreground">{pkg.title || pkg.name}</span>
        </nav>

        {/* Title */}
        <h1 className="text-3xl font-bold tracking-tight">{pkg.title || pkg.name}</h1>

        {/* Organization / Groups / Tags */}
        {(pkg.organization || pkg.groups.length > 0 || pkg.tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {pkg.organization && (
              <Link
                href={`/organization/${pkg.organization.name}`}
                className="flex items-center gap-1 hover:text-foreground"
              >
                <Building2 className="h-3.5 w-3.5" />
                {pkg.organization.title || pkg.organization.name}
              </Link>
            )}
            {pkg.groups.map((g) => (
              <Link
                key={g.id}
                href={`/group/${g.name}`}
                className="flex items-center gap-1 hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {g.title || g.name}
              </Link>
            ))}
            {pkg.tags.map((pkgTag) => (
              <Link key={pkgTag.id} href={`/dataset?tags=${encodeURIComponent(pkgTag.name)}`}>
                <Badge variant="secondary" className="text-xs hover:bg-accent">
                  <Tag className="mr-0.5 h-3 w-3" />
                  {pkgTag.name}
                </Badge>
              </Link>
            ))}
          </div>
        )}

        {/* Description */}
        {pkg.notes && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(pkg.notes)}
            </div>
          </>
        )}

        {/* Resources */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">
            {t('resources')}
            {pkg.resources.length > 0 && ` (${pkg.resources.length})`}
          </h2>
          {pkg.resources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noResources')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {pkg.resources.map((r) => (
                <ResourceCard
                  key={r.id}
                  resource={r}
                  packageName={pkg.name}
                  downloadLabel={tr('download')}
                />
              ))}
            </div>
          )}
        </section>

        {/* Additional Info */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">{t('additionalInfo')}</h2>
          <KeyValueTable
            rows={[
              { label: t('maintainer'), value: pkg.maintainer },
              { label: t('author'), value: pkg.author },
              { label: t('license'), value: pkg.licenseId },
              { label: t('version'), value: pkg.version },
              { label: t('created'), value: <DateTime value={pkg.created} /> },
              { label: t('updated'), value: <DateTime value={pkg.updated} /> },
              {
                label: t('sourceUrl'),
                value: pkg.url ? (
                  <a
                    href={pkg.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-primary underline-offset-4 hover:underline"
                  >
                    {pkg.url}
                  </a>
                ) : null,
              },
              ...extrasToRows(pkg.extras),
            ]}
          />
        </section>
      </div>
    </div>
  )
}

function ResourceCard({
  resource,
  packageName,
  downloadLabel,
}: {
  resource: Resource
  packageName: string
  downloadLabel: string
}) {
  return (
    <Card className="py-0">
      <CardContent className="flex items-center gap-4 px-4 py-3">
        <span
          className={`inline-flex min-w-[56px] items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase ${getFormatColorClass(resource.format)}`}
        >
          {resource.format || '?'}
        </span>

        <div className="min-w-0 flex-1">
          <Link
            href={`/dataset/${packageName}/resource/${resource.id}`}
            className="truncate font-medium hover:underline"
          >
            {resource.name || 'Unnamed Resource'}
          </Link>
          {resource.description && (
            <p className="truncate text-sm text-muted-foreground">{resource.description}</p>
          )}
        </div>

        <DownloadButton
          datasetNameOrId={packageName}
          resourceId={resource.id}
          filename={resource.url || resource.id}
          label={downloadLabel}
        />
      </CardContent>
    </Card>
  )
}
