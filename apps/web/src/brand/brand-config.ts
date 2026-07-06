import type { BrandConfig } from '@/types/brand'

export const brandConfig: BrandConfig = {
  siteName: 'KUKAN',
  siteDescription: 'Knowledge Unified Katalog And Network',
  copyright: 'KUKAN Contributors. AGPL-3.0 License.',
  copyrightUrl: 'https://github.com/kukan-project/kukan',

  logo: { type: 'default' },

  headerNavExtra: [],
  footerLinks: [{ label: '利用規約', href: '/terms' }],

  ogImage: '/og-default.png',
  faviconPath: '/favicon.ico',

  gaMeasurementId: null,

  searchExampleQueries: [],
}
