import { resolve } from 'node:path'
import { config } from 'dotenv'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

config({ path: '../../.env' })

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

// Multi-brand build (ADR-042): the default brand resolves via the tsconfig
// `@/brand` → brands/default path. Only a non-default KUKAN_BRAND needs an
// alias override here, pointing `@/brand` and each subpath at brands/<brand>.
// Turbopack resolveAlias is exact-match (no prefix), so every entry is listed;
// values are project-relative for Turbopack and absolute for webpack.
const brand = process.env.KUKAN_BRAND
const brandBase = brand && brand !== 'default' ? `./brands/${brand}` : undefined
const brandAliasRel: Record<string, string> = brandBase
  ? {
      '@/brand': `${brandBase}/index`,
      '@/brand/theme.css': `${brandBase}/theme.css`,
      '@/brand/pages': `${brandBase}/pages`,
      '@/brand/brand-config': `${brandBase}/brand-config`,
      '@/brand/messages': `${brandBase}/messages`,
    }
  : {}
const brandAliasAbs: Record<string, string> = Object.fromEntries(
  Object.entries(brandAliasRel).map(([key, rel]) => [key, resolve(__dirname, rel)])
)

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@kukan/shared', '@kukan/ui'],
  serverExternalPackages: [
    '@kukan/api',
    '@kukan/db',
    '@kukan/storage-adapter',
    '@kukan/search-adapter',
    '@kukan/queue-adapter',
    '@kukan/ai-adapter',
    // Native addon for server-side DuckDB queries (ADR-032 Part B): must stay external
    // so its prebuilt .node binary is required at runtime rather than bundled.
    '@duckdb/node-api',
    'pino',
    'pino-pretty',
  ],
  headers: () => [{ source: '/(.*)', headers: securityHeaders }],
  // Brand alias for both bundlers (ADR-042). Empty for the default brand.
  turbopack: { resolveAlias: brandAliasRel },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = { ...webpackConfig.resolve.alias, ...brandAliasAbs }
    return webpackConfig
  },
}

export default withNextIntl(nextConfig)
