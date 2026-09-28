'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Building2,
  ChartColumn,
  Database,
  HeartPulse,
  LayoutDashboard,
  ListTodo,
  Megaphone,
  ScanSearch,
  Settings,
  Sparkles,
  Tags,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'

interface SidebarItem {
  href: string
  label: string
  icon: LucideIcon
  exact?: boolean
}

export function Sidebar() {
  const pathname = usePathname()
  const t = useTranslations('dashboard.sidebar')
  const user = useUser()

  const sidebarItems: SidebarItem[] = [
    { href: '/dashboard', label: t('dashboard'), icon: LayoutDashboard, exact: true },
    { href: '/dashboard/datasets', label: t('datasets'), icon: Database },
    { href: '/dashboard/organizations', label: t('organizations'), icon: Building2 },
    { href: '/dashboard/groups', label: t('categories'), icon: Tags },
  ]

  // People and notices first, then what is happening, what rebuilds derived
  // data, and the site's settings
  const adminItems: SidebarItem[] = [
    { href: '/dashboard/admin/users', label: t('adminUsers'), icon: Users },
    { href: '/dashboard/admin/announcements', label: t('adminAnnouncements'), icon: Megaphone },
    { href: '/dashboard/admin/health', label: t('adminHealth'), icon: HeartPulse },
    { href: '/dashboard/admin/jobs', label: t('adminJobs'), icon: Workflow },
    { href: '/dashboard/admin/queue', label: t('adminQueue'), icon: ListTodo },
    { href: '/dashboard/admin/analytics', label: t('adminAnalytics'), icon: ChartColumn },
    { href: '/dashboard/admin/search', label: t('adminSearch'), icon: ScanSearch },
    { href: '/dashboard/admin/ai', label: t('adminAi'), icon: Sparkles },
    { href: '/dashboard/admin/site', label: t('adminSite'), icon: Settings },
  ]

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const linkClass = (href: string, exact?: boolean) =>
    cn(
      'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
      isActive(href, exact) && 'bg-accent text-accent-foreground'
    )

  return (
    <aside className="hidden w-56 shrink-0 md:block">
      <nav className="flex flex-col gap-1 py-4">
        {sidebarItems.map((item) => (
          <Link key={item.href} href={item.href} className={linkClass(item.href, item.exact)}>
            <item.icon aria-hidden className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        ))}
        {user.sysadmin && (
          <>
            <div className="mt-4 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('adminSection')}
            </div>
            {adminItems.map((item) => (
              <Link key={item.href} href={item.href} className={linkClass(item.href)}>
                <item.icon aria-hidden className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            ))}
          </>
        )}
      </nav>
    </aside>
  )
}
