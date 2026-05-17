import type { ComponentType } from 'react'

export interface NavItem {
  label: string
  href: string
  external?: boolean
}

export type LogoConfig =
  | { type: 'default' }
  | { type: 'image'; src: string; width: number; height: number; alt: string }

/** ブランド設定の型定義 */
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
}

/** コンポーネントオーバーライドのスロット定義 */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
}
