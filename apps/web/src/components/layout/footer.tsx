import { useLocale } from 'next-intl'
import { Separator } from '@kukan/ui'
import { overrides } from '@/brand'
import { resolveBrandConfig } from '@/lib/resolved-brand'

const START_YEAR = 2026

export function Footer() {
  const Custom = overrides.Footer
  if (Custom) return <Custom />
  return <DefaultFooter />
}

export function DefaultFooter() {
  const brand = resolveBrandConfig(useLocale())
  const currentYear = new Date().getFullYear()
  const yearDisplay = currentYear > START_YEAR ? `${START_YEAR}\u2013${currentYear}` : START_YEAR

  return (
    <footer className="mt-auto">
      <Separator />
      <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] items-center justify-between px-4 py-6">
        <div className="flex items-center gap-4">
          {brand.copyrightUrl ? (
            <a
              href={brand.copyrightUrl}
              className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[1px] hover:text-foreground"
              target="_blank"
              rel="noopener noreferrer"
            >
              {brand.siteName}
            </a>
          ) : (
            <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[1px]">
              {brand.siteName}
            </span>
          )}
          {brand.footerLinks.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              {...(item.external && { target: '_blank', rel: 'noopener noreferrer' })}
            >
              {item.label}
            </a>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          &copy; {yearDisplay} {brand.copyright}
        </span>
      </div>
    </footer>
  )
}
