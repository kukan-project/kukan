import type { ComponentType } from 'react'
import type { LocalizedText } from '@/i18n/locales'

export interface NavItem {
  label: LocalizedText
  href: string
  external?: boolean
}

export type LogoConfig =
  | { type: 'default' }
  | { type: 'image'; src: string; width: number; height: number; alt: LocalizedText }

/** Brand configuration */
export interface BrandConfig {
  siteName: LocalizedText
  siteDescription: LocalizedText
  copyright: LocalizedText
  copyrightUrl?: string
  logo: LogoConfig
  headerNavExtra: NavItem[]
  footerLinks: NavItem[]
  ogImage: string
  faviconPath: string
  /** GA4 Measurement ID (e.g. 'G-XXXXXXXXXX'). null = GA4 disabled. */
  gaMeasurementId?: string | null
  /**
   * When true, emit a site-wide `noindex, nofollow` robots meta tag.
   * Crawling itself stays allowed — blocking it in robots.txt would hide the meta tag.
   */
  noindex?: boolean
  /**
   * Sources a brand adds to the pages' Content-Security-Policy (ADR-071),
   * directive → sources, e.g. `{ 'frame-src': ["'self'"] }`. Appended to the
   * directive's own sources; a directive the policy lacks holds the brand's alone.
   */
  csp?: Partial<Record<string, string[]>>
}

/** Component override slots */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
  TopPage?: ComponentType
}
