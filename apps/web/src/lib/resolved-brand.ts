// brand-config subpath, not the barrel — the barrel pulls fork overrides into client bundles
import { brandConfig } from '@/brand/brand-config'
import type { NavItem } from '@/types/brand'
import { resolveLocalizedText } from '@/i18n/locales'

const resolved = new Map<string, ReturnType<typeof resolve>>()

/** Resolve every LocalizedText field of the active brand config for one locale. */
export function resolveBrandConfig(locale: string) {
  let cached = resolved.get(locale)
  if (!cached) {
    cached = resolve(locale)
    resolved.set(locale, cached)
  }
  return cached
}

function resolve(locale: string) {
  const resolveNav = (items: NavItem[]) =>
    items.map((item) => ({ ...item, label: resolveLocalizedText(item.label, locale) }))

  return {
    ...brandConfig,
    siteName: resolveLocalizedText(brandConfig.siteName, locale),
    siteDescription: resolveLocalizedText(brandConfig.siteDescription, locale),
    copyright: resolveLocalizedText(brandConfig.copyright, locale),
    logo:
      brandConfig.logo.type === 'image'
        ? { ...brandConfig.logo, alt: resolveLocalizedText(brandConfig.logo.alt, locale) }
        : brandConfig.logo,
    headerNavExtra: resolveNav(brandConfig.headerNavExtra),
    footerLinks: resolveNav(brandConfig.footerLinks),
  }
}
