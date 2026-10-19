import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as index } from '../sitemap.xml/route'
import { GET as file } from '../sitemap/[kind]/[file]/route'

const brand = vi.hoisted(() => ({ brandConfig: { noindex: false } }))
vi.mock('@/brand/brand-config', () => brand)
const asked = vi.hoisted(() => [] as string[])
vi.mock('@/lib/hono-app', () => ({
  getApp: async () => ({
    request: async (url: string, init?: RequestInit) => {
      asked.push(url)
      expect(new Headers(init?.headers).get('cookie')).toBeNull()
      return new Response('<xml/>', { headers: { 'Content-Type': 'application/xml' } })
    },
  }),
}))

const getFile = (kind: string, name: string) =>
  file(new Request('http://x'), { params: Promise.resolve({ kind, file: name }) })

beforeEach(() => {
  brand.brandConfig.noindex = false
  asked.length = 0
})

describe('sitemap routes', () => {
  it('pass the API’s XML through, from its in-process path', async () => {
    expect(await (await index()).text()).toBe('<xml/>')
    expect(await (await getFile('datasets', '0.xml')).text()).toBe('<xml/>')
    expect(asked).toEqual([
      'http://localhost/internal/sitemap',
      'http://localhost/internal/sitemap/datasets/0.xml',
    ])
  })

  it('refuse a kind or a file that is no sitemap path, without asking the API', async () => {
    for (const [kind, name] of [
      ['..', '0.xml'],
      ['%2e%2e', '0.xml'],
      ['datasets', '..'],
      ['datasets', '0.json'],
      ['Datasets', '0.xml'],
    ]) {
      expect((await getFile(kind, name)).status).toBe(404)
    }
    expect(asked).toEqual([])
  })

  it('answer 404 on a noindex brand, without asking the API', async () => {
    brand.brandConfig.noindex = true
    expect((await index()).status).toBe(404)
    expect((await getFile('datasets', '0.xml')).status).toBe(404)
    expect(asked).toEqual([])
  })
})
