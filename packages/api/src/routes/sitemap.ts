/** The sitemap's XML, at SITEMAP_BASE_PATH — see there for who reaches it */

import { Hono } from 'hono'
import { publicOrigin } from '@kukan/shared'
import { SitemapService } from '../services/sitemap-service'
import type { AppContext } from '../context'

/** Crawlers fetch it rarely; an hour old is fresh enough */
const HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
}

export const sitemapRouter = new Hono<{ Variables: AppContext }>()

sitemapRouter.get('/', async (c) => {
  const xml = await new SitemapService(c.get('db')).indexXml(publicOrigin(c.get('env')))
  return c.body(xml, 200, HEADERS)
})

sitemapRouter.get('/:kind/:file', async (c) => {
  const service = new SitemapService(c.get('db'))
  const xml = await service.fileXml(
    publicOrigin(c.get('env')),
    c.req.param('kind'),
    c.req.param('file')
  )
  return xml === null ? c.body(null, 404) : c.body(xml, 200, HEADERS)
})
