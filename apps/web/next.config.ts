import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@kukan/shared', '@kukan/ui'],
}

export default nextConfig
