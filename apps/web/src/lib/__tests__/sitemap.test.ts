import { describe, it, expect, vi } from 'vitest'
import { sitemapResponse } from '../sitemap'

vi.mock('@/brand/brand-config', () => ({ brandConfig: { noindex: false } }))
const request = vi.hoisted(() => vi.fn(async () => new Response('<xml/>')))
vi.mock('../hono-app', () => ({ getApp: async () => ({ request }) }))

describe('sitemapResponse', () => {
  it('asks only for paths under the sitemap, whatever the path resolves to', async () => {
    expect((await sitemapResponse('/datasets/0.xml')).status).toBe(200)
    expect(request).toHaveBeenLastCalledWith('http://localhost/internal/sitemap/datasets/0.xml')
    request.mockClear()
    for (const path of ['/../0.xml', '/../../api/v1/users', '/..']) {
      expect((await sitemapResponse(path)).status).toBe(404)
    }
    expect(request).not.toHaveBeenCalled()
  })
})
