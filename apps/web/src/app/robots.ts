import type { MetadataRoute } from 'next'
import { brandConfig } from '@/brand/brand-config'
import { siteOrigin } from '@/lib/site-origin'

// The host comes from the runtime env (a site per deployment), not the build
export const dynamic = 'force-dynamic'

/**
 * Crawl rules. Query strings on the lists are turned away whole: the
 * filters multiply into endless URLs, and the datasets they lead to come from
 * the sitemap and the organization, category and tag pages instead. A noindex
 * brand still lets crawlers in — blocking them would hide its noindex meta —
 * but names no sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      // OData is a feed for BI tools, which do not read this; a crawl of it only costs queries
      disallow: [
        '/dataset?',
        '/organization?',
        '/group?',
        '/api/',
        '/odata/',
        '/dashboard',
        '/auth/',
      ],
    },
    ...(!brandConfig.noindex && { sitemap: `${siteOrigin()}/sitemap.xml` }),
  }
}
