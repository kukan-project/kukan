import 'server-only'

import { SITEMAP_BASE_PATH } from '@kukan/shared'
import { brandConfig } from '@/brand/brand-config'
import { getApp } from './hono-app'

/**
 * A sitemap route's answer: 404 on a noindex brand — a build-time
 * setting the API never sees — and otherwise the API's XML, asked in-process
 * with no cookie, as what it lists must not depend on who asks.
 */
export async function sitemapResponse(path: string): Promise<Response> {
  if (brandConfig.noindex) return new Response(null, { status: 404 })
  const url = new URL(`http://localhost${SITEMAP_BASE_PATH}${path}`)
  // Only the sitemap's own paths, whatever `path` resolved to
  if (url.pathname !== SITEMAP_BASE_PATH && !url.pathname.startsWith(`${SITEMAP_BASE_PATH}/`)) {
    return new Response(null, { status: 404 })
  }
  const app = await getApp()
  return app.request(url.href)
}
