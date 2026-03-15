import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Separator } from '@kukan/ui'

export function Footer() {
  const t = useTranslations('common')
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] items-center justify-between px-4 py-6">
        <div className="flex items-center gap-6">
          <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[1px]">
            KUKAN
          </span>
          <span className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} KUKAN Contributors. MIT License.
          </span>
        </div>
        <nav className="flex gap-5">
          <Link
            href="/dataset"
            className="text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            {t('datasets')}
          </Link>
          <Link
            href="/organization"
            className="text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            {t('organizations')}
          </Link>
        </nav>
      </div>
    </footer>
  )
}
