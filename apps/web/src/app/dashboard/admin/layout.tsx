import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/server-api'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user || !user.sysadmin) redirect('/dashboard')

  return <>{children}</>
}
