import Link from 'next/link'
import { Button, Separator } from '@kukan/ui'
import { getCurrentUser } from '@/lib/api'
import { UserMenu } from '@/components/auth/user-menu'
import { MobileNav } from './mobile-nav'

const navItems = [
  { href: '/dataset', label: 'データセット' },
  { href: '/organization', label: '組織' },
  { href: '/group', label: 'グループ' },
]

export async function Header() {
  const user = await getCurrentUser()

  return (
    <header className="sticky top-0 z-40 bg-background">
      <div className="mx-auto flex h-[var(--kukan-header-height)] max-w-[var(--kukan-container-max-width)] items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-primary text-sm font-bold text-primary-foreground shadow-sm">
              K
            </span>
            <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-[1.5px]">
              KUKAN
            </span>
          </Link>
          <nav className="hidden items-center gap-4 md:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <UserMenu user={user} />
          ) : (
            <Button asChild variant="outline" size="sm">
              <Link href="/auth/sign-in">ログイン</Link>
            </Button>
          )}
          <MobileNav user={user} />
        </div>
      </div>
      <Separator />
    </header>
  )
}
