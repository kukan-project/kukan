import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getCurrentUser } from '@/lib/server-api'
import { siteTitle } from '@/lib/page-metadata'
import { Sidebar } from '@/components/layout/sidebar'
import { UserProvider } from '@/components/dashboard/user-provider'
import { Separator } from '@kukan/ui'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('dashboard')
  return { title: await siteTitle(t('title')) }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/sign-in')

  return (
    <UserProvider user={user}>
      <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] gap-6 px-4 py-6">
        <Sidebar />
        <Separator orientation="vertical" className="hidden md:block" />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </UserProvider>
  )
}
