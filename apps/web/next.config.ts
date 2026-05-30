import { config } from 'dotenv'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

config({ path: '../../.env' })

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

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
    'pino',
    'pino-pretty',
  ],
  headers: () => [{ source: '/(.*)', headers: securityHeaders }],
}

export default withNextIntl(nextConfig)
