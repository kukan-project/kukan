import type { ComponentType } from 'react'

export interface NavItem {
  label: string
  href: string
  external?: boolean
}

export type LogoConfig =
  | { type: 'default' }
  | { type: 'image'; src: string; width: number; height: number; alt: string }

/** Brand configuration */
export interface BrandConfig {
  siteName: string
  siteDescription: string
  copyright: string
  copyrightUrl?: string
  logo: LogoConfig
  headerNavExtra: NavItem[]
  footerLinks: NavItem[]
  ogImage: string
  faviconPath: string
  /** GA4 Measurement ID (e.g. 'G-XXXXXXXXXX'). null = GA4 disabled. */
  gaMeasurementId?: string | null
  /** Example search queries shown as chips, tailored to the deployment's data. Empty = hidden. */
  searchExampleQueries: string[]
}

/** Component override slots */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
  TopPage?: ComponentType
}
