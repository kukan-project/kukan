import type { BrandConfig, BrandOverrides } from '@/types/brand'

// Stand-in for the `@/brand` module in body tests. Forks rewrite the real
// `brands/default/` contents (ADR-023/042), so body tests must not import it
// directly —
// assertions against default text and components would break on every fork.
// Tests that render brand-consuming components mock it instead:
//
//   vi.mock('@/brand', () => import('@/__tests__/brand-defaults'))
//
// The values below are an intentional copy of the KUKAN defaults and are
// managed by the body repo, independent of fork customizations.
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
}

export const overrides: BrandOverrides = {}
