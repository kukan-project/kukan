import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api'
import { Sidebar } from '@/components/layout/sidebar'
import { Separator } from '@kukan/ui'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const res = await serverFetch('/api/v1/users/me')
  if (!res.ok) {
    redirect('/auth/sign-in')
  }

  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] gap-6 px-4 py-6">
      <Sidebar />
      <Separator orientation="vertical" className="hidden md:block" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
