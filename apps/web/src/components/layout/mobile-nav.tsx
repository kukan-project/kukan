'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button, cn, Separator, Sheet, SheetContent, SheetHeader, SheetTitle } from '@kukan/ui'

const navItems = [
  { href: '/dataset', label: 'データセット' },
  { href: '/organization', label: '組織' },
  { href: '/group', label: 'グループ' },
]

interface MobileNavProps {
  user: { name: string; email: string } | null
}

export function MobileNav({ user }: MobileNavProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  return (
    <div className="md:hidden">
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="メニューを開く">
        <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>KUKAN</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-2 p-4">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
                  pathname.startsWith(item.href) && 'bg-accent text-accent-foreground'
                )}
              >
                {item.label}
              </Link>
            ))}
            <Separator className="my-2" />
            {user ? (
              <Link
                href="/dashboard"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                ダッシュボード
              </Link>
            ) : (
              <Link
                href="/auth/sign-in"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                ログイン
              </Link>
            )}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  )
}
