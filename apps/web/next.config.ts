import { config } from 'dotenv'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

config({ path: '../../.env' })

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  transpilePackages: ['@kukan/shared', '@kukan/ui'],
  serverExternalPackages: [
    '@kukan/api',
    '@kukan/db',
    '@kukan/storage-adapter',
    '@kukan/search-adapter',
    '@kukan/queue-adapter',
    '@kukan/ai-adapter',
    '@kukan/pipeline',
  ],
}

export default withNextIntl(nextConfig)
