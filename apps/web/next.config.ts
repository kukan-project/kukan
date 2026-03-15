import { config } from 'dotenv'
import type { NextConfig } from 'next'

config({ path: '../../.env' })

const nextConfig: NextConfig = {
  transpilePackages: [
    '@kukan/shared',
    '@kukan/ui',
    '@kukan/api',
    '@kukan/db',
    '@kukan/storage-adapter',
    '@kukan/search-adapter',
    '@kukan/queue-adapter',
    '@kukan/ai-adapter',
  ],
  serverExternalPackages: ['pg', 'pg-connection-string'],
}

export default nextConfig
