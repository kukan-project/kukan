import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/dashboard/page-header'
import { DataResetCard } from '@/components/dashboard/site/data-reset-card'
import { RegistrationCard } from '@/components/dashboard/site/registration-card'
import { SearchExamplesCard } from '@/components/dashboard/site/search-examples-card'
import { SiteMetadataCard } from '@/components/dashboard/site/site-metadata-card'
import { SystemInfoCard } from '@/components/dashboard/site/system-info-card'
import { buildInfo } from '@/lib/build-info'
import { getCurrentUser } from '@/lib/server-api'

export default async function AdminSitePage() {
  const t = await getTranslations('dashboard.adminSite')

  // Checked here, not left to the layout above. A layout is not re-rendered on
  // every navigation, and the client says which layouts it already holds, so a
  // request can be answered with this page alone. The check belongs next to
  // what it protects. `getCurrentUser` is React-cached, so the layout's call
  // and this one are one request.
  const user = await getCurrentUser()
  if (!user?.sysadmin) redirect('/dashboard')

  // Read in the process the question is about (ADR-012 puts the API in it)
  const build = buildInfo()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* What this deployment is running — read, not set, so it comes first */}
      <SystemInfoCard build={build} />

      {/* Site-wide values brands read by key (ADR-064) */}
      <SiteMetadataCard />

      {/* Example Query Chips */}
      <SearchExamplesCard />

      {/* Self-Registration */}
      <RegistrationCard />

      <DataResetCard />
    </div>
  )
}
