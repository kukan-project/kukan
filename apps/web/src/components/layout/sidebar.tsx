'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@kukan/ui'

const sidebarItems = [
  { href: '/dashboard', label: 'ダッシュボード', exact: true },
  { href: '/dashboard/datasets', label: 'データセット' },
  { href: '/dashboard/organizations', label: '組織' },
  { href: '/dashboard/groups', label: 'グループ' },
  { href: '/dashboard/api-tokens', label: 'APIトークン' },
  { href: '/dashboard/profile', label: 'プロフィール' },
]

export function Sidebar() {
  const pathname = usePathname()

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  return (
    <aside className="hidden w-56 shrink-0 md:block">
      <nav className="flex flex-col gap-1 py-4">
        {sidebarItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
              isActive(item.href, item.exact) && 'bg-accent text-accent-foreground'
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  )
}
