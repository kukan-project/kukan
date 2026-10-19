import { publicOrigin } from '@kukan/shared'

/**
 * The site's public origin, for absolute URLs (metadataBase, robots, sitemap,
 * JSON-LD). Read at runtime: a site per deployment, one build per brand.
 */
export function siteOrigin(): string {
  return publicOrigin({ BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || 'http://localhost:3000' })
}
