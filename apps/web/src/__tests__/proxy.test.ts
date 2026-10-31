import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { config, proxy } from '../proxy'
import { IBIS_OFFICE_BOOT, IBIS_OFFICE_DIR } from '@/lib/ibis-office'

const ORIGIN = 'https://catalog.example.jp'

function cspFor(url: string, headers?: Record<string, string>): string {
  const request = new NextRequest(url, { headers })
  return proxy(request).headers.get('content-security-policy')!
}

/** As a server receives it: the test environment's Request drops a `host` it is given. */
function cspForHost(url: string, host: string): string {
  const request = new NextRequest(url)
  vi.spyOn(request.headers, 'get').mockImplementation((name) => (name === 'host' ? host : null))
  return proxy(request).headers.get('content-security-policy')!
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
})
afterEach(() => vi.unstubAllEnvs())

describe('proxy (ADR-065 decision 2)', () => {
  it('limits every page’s frames to the boot page and the PDF preview', () => {
    expect(cspFor(`${ORIGIN}/`)).toBe(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/`
    )
    expect(cspFor(`${ORIGIN}/dataset/some-dataset`)).toBe(cspFor(`${ORIGIN}/`))
  })

  it('names the host asked for too, for a site reached under another name', () => {
    expect(cspForHost('http://localhost:3000/', '192.0.2.1:3000')).toBe(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ ` +
        `http://192.0.2.1:3000${IBIS_OFFICE_BOOT} http://192.0.2.1:3000/api/v1/resources/`
    )
  })

  it('takes no host from a header a viewer can send through CloudFront', () => {
    expect(cspFor(`${ORIGIN}/`, { 'x-forwarded-host': 'evil.example' })).not.toContain('evil')
  })

  it('lets no Host write into the policy', () => {
    expect(cspForHost(`${ORIGIN}/`, 'evil.example;script-src')).not.toContain('evil')
  })

  it('lets a frame show Microsoft’s viewer only on an office-online site', () => {
    expect(cspFor(`${ORIGIN}/`)).not.toContain('officeapps')
    vi.stubEnv('OFFICE_PREVIEW_VIEWER', 'office-online')
    expect(cspFor(`${ORIGIN}/`)).toContain('https://view.officeapps.live.com')
  })

  it('sandboxes the boot page itself and lets it reach only the app', () => {
    const app = `${ORIGIN}${IBIS_OFFICE_DIR}`
    const response = proxy(new NextRequest(`${ORIGIN}${IBIS_OFFICE_BOOT}`))
    expect(response.headers.get('content-security-policy')).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src ${app} 'wasm-unsafe-eval'; ` +
        `connect-src ${app}; img-src ${app} data: blob:; style-src 'unsafe-inline'; ` +
        `font-src ${app} data:; frame-ancestors 'self'`
    )
    expect(response.headers.get('x-dns-prefetch-control')).toBe('off')
  })

  it('sandboxes the boot page under any spelling of its path', () => {
    const spelled = IBIS_OFFICE_BOOT.replace('boot.html', '%62oot.html')
    expect(cspFor(`${ORIGIN}${spelled}`)).toMatch(/^sandbox allow-scripts; /)
  })

  it('runs for prefetches too, whose responses CloudFront’s HTML cache keeps for everyone', () => {
    expect(config.matcher).toEqual(['/((?!api/|_next/static/|_next/image).*)'])
  })
})
