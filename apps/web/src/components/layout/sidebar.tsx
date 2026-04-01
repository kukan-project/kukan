'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'

export function Sidebar() {
  const pathname = usePathname()
  const t = useTranslations('dashboard.sidebar')
  const user = useUser()

  const sidebarItems = [
    { href: '/dashboard', label: t('dashboard'), exact: true },
    { href: '/dashboard/datasets', label: t('datasets') },
    { href: '/dashboard/organizations', label: t('organizations') },
    { href: '/dashboard/groups', label: t('categories') },
    { href: '/dashboard/api-tokens', label: t('apiTokens') },
    { href: '/dashboard/profile', label: t('profile') },
  ]

  const adminItems = [{ href: '/dashboard/admin/jobs', label: t('adminJobs') }]

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const linkClass = (href: string, exact?: boolean) =>
    cn(
      'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
      isActive(href, exact) && 'bg-accent text-accent-foreground'
    )

  return (
    <aside className="hidden w-56 shrink-0 md:block">
      <nav className="flex flex-col gap-1 py-4">
        {sidebarItems.map((item) => (
          <Link key={item.href} href={item.href} className={linkClass(item.href, item.exact)}>
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
                {item.label}
              </Link>
            ))}
          </>
        )}
      </nav>
    </aside>
  )
}
