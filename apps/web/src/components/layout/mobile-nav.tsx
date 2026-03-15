'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Globe, Menu } from 'lucide-react'
import { Button, cn, Separator, Sheet, SheetContent, SheetHeader, SheetTitle } from '@kukan/ui'

interface MobileNavProps {
  user: { name: string; email: string } | null
}

export function MobileNav({ user }: MobileNavProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const locale = useLocale()
  const t = useTranslations('common')

  const navItems = [
    { href: '/dataset', label: t('datasets') },
    { href: '/organization', label: t('organizations') },
    { href: '/group', label: t('categories') },
  ]

  const toggleLocale = () => {
    const next = locale === 'ja' ? 'en' : 'ja'
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; SameSite=Lax`
    setOpen(false)
    window.location.reload()
  }

  return (
    <div className="md:hidden">
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label={t('openMenu')}>
        <Menu className="size-5" />
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
                {t('dashboard')}
              </Link>
            ) : (
              <Link
                href="/auth/sign-in"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {t('login')}
              </Link>
            )}
            <Separator className="my-2" />
            <button
              onClick={toggleLocale}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Globe className="size-4" />
              {locale === 'ja' ? 'English' : '日本語'}
            </button>
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  )
}
