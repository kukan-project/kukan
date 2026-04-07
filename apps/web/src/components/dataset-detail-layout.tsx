import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Building2, Calendar, FolderOpen, Scale, Tag } from 'lucide-react'
import { Badge, Separator } from '@kukan/ui'
import { resolveLicenseLabel } from '@kukan/shared'
import { serverFetch, getCurrentUser } from '@/lib/server-api'
import { renderSimpleMarkdown } from '@/lib/render-markdown'
import { DateTime } from '@/components/date-time'
import { DatasetMetadata } from '@/components/dataset-metadata'
import { ResourceExplorer, type Resource } from '@/components/resource-explorer'

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
  ownerOrg?: string | null
  private: boolean
  created: string
  updated: string
  extras?: Record<string, unknown> | null
  resources: Resource[]
  tags: { id: string; name: string }[]
  groups: { id: string; name: string; title?: string | null }[]
  organization: Organization | null
}

interface DatasetDetailLayoutProps {
  pkg: Package
  initialResourceId?: string
}

export async function DatasetDetailLayout({ pkg, initialResourceId }: DatasetDetailLayoutProps) {
  const [t, tl, user, orgsRes] = await Promise.all([
    getTranslations('dataset'),
    getTranslations('license'),
    getCurrentUser(),
    serverFetch('/api/v1/users/me/organizations').catch(() => null),
  ])

  let canManage = false
  if (user) {
    if (user.sysadmin) {
      canManage = true
    } else if (pkg.ownerOrg && orgsRes?.ok) {
      const data = await orgsRes.json()
      canManage = data.items?.some((org: { id: string }) => org.id === pkg.ownerOrg)
    }
  }

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

        {/* Organization / Groups / Tags / License / Dates */}
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          {(pkg.organization || pkg.licenseId || pkg.groups.length > 0 || pkg.tags.length > 0) && (
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
              {pkg.licenseId && (
                <span className="flex shrink-0 items-center gap-1">
                  <Scale className="h-3.5 w-3.5" />
                  {resolveLicenseLabel(pkg.licenseId!, tl)}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-col items-end gap-1">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {t('createdShort')}: <DateTime value={pkg.created} />
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {t('updatedShort')}: <DateTime value={pkg.updated} />
            </span>
          </div>
        </div>

        {/* Description */}
        {pkg.notes && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(pkg.notes)}
            </div>
          </>
        )}

        {/* Additional Info (collapsible) */}
        <Separator />
        <DatasetMetadata pkg={pkg} />

        {/* Resources */}
        <Separator />
        <section>
          {pkg.resources.length === 0 ? (
            <>
              <h2 className="mb-4 text-xl font-semibold">{t('resources')}</h2>
              <p className="text-sm text-muted-foreground">{t('noResources')}</p>
            </>
          ) : (
            <ResourceExplorer
              resources={pkg.resources}
              packageName={pkg.name}
              sectionTitle={`${t('resources')} (${pkg.resources.length})`}
              initialResourceId={initialResourceId}
              canManage={canManage}
            />
          )}
        </section>
      </div>
    </div>
  )
}
