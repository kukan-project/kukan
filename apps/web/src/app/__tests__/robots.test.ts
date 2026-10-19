import { describe, it, expect, vi, beforeEach } from 'vitest'
import robots from '../robots'

const brand = vi.hoisted(() => ({ brandConfig: { noindex: false } }))
vi.mock('@/brand/brand-config', () => brand)

const DISALLOW = [
  '/dataset?',
  '/organization?',
  '/group?',
  '/api/',
  '/odata/',
  '/dashboard',
  '/auth/',
]

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://data.example.jp')
})

describe('robots', () => {
  it('turns list queries away and names the sitemap on the public host', () => {
    brand.brandConfig.noindex = false
    expect(robots()).toEqual({
      rules: { userAgent: '*', disallow: DISALLOW },
      sitemap: 'https://data.example.jp/sitemap.xml',
    })
  })

  it('lets crawlers in on a noindex brand, so they read its noindex, but names no sitemap', () => {
    brand.brandConfig.noindex = true
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: DISALLOW } })
  })
})
