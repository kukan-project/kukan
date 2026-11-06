import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { config, proxy } from '../proxy'
import { IBIS_OFFICE_BOOT, IBIS_OFFICE_DIR } from '@/lib/ibis-office'
import { buildContentSecurityPolicy } from '@/lib/csp'
import { brandConfig } from '@/brand/brand-config'

// A copy of the defaults the brand test below may add to
vi.mock('@/brand/brand-config', async () => {
  const defaults = await import('@/__tests__/brand-defaults')
  return { brandConfig: { ...defaults.brandConfig } }
})

const ORIGIN = 'https://catalog.example.jp'

function cspFor(url: string, headers?: Record<string, string>): string {
  const request = new NextRequest(url, { headers })
  return proxy(request).headers.get('content-security-policy')!
}

/** As a server receives it: the test environment's Request drops a `host` it is given. */
function cspForHost(url: string, host: string, headers?: Record<string, string>): string {
  const request = new NextRequest(url, { headers })
  vi.spyOn(request.headers, 'get').mockImplementation((name) => (name === 'host' ? host : null))
  return proxy(request).headers.get('content-security-policy')!
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete brandConfig.csp
})

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

  it('leaves out the Host CloudFront sends, a load balancer’s name', () => {
    const host = 'internal-kukan-alb-123456789.ap-northeast-1.elb.amazonaws.com'
    const headers = { 'x-amz-cf-id': 'abc123' }
    expect(cspForHost(`${ORIGIN}/`, host, headers)).toBe(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/`
    )
    expect(cspForHost(`${ORIGIN}${IBIS_OFFICE_BOOT}`, host, headers)).not.toContain('elb')
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
    expect(config.matcher).toEqual(['/((?!api/|_next/static/).*)'])
  })
})

describe('proxy (ADR-071)', () => {
  const policy = () =>
    buildContentSecurityPolicy({ origins: [ORIGIN], officeOnline: false, ga: false, dev: false })
      .policy

  it('reports the full policy beside the enforced frame-src by default', () => {
    const headers = proxy(new NextRequest(`${ORIGIN}/`)).headers
    expect(headers.get('content-security-policy')).toBe(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/`
    )
    expect(headers.get('content-security-policy-report-only')).toBe(policy())
    expect(policy()).toContain("default-src 'self'")
  })

  it('enforces the full policy, frame-src inside it, under CSP_MODE=enforce', () => {
    vi.stubEnv('CSP_MODE', 'enforce')
    const headers = proxy(new NextRequest(`${ORIGIN}/`)).headers
    expect(headers.get('content-security-policy')).toBe(policy())
    expect(headers.get('content-security-policy')).toContain(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/`
    )
    expect(headers.get('content-security-policy-report-only')).toBeNull()
  })

  it('carries Microsoft’s viewer in the enforced policy’s frame-src too', () => {
    vi.stubEnv('CSP_MODE', 'enforce')
    vi.stubEnv('OFFICE_PREVIEW_VIEWER', 'office-online')
    expect(cspFor(`${ORIGIN}/`)).toContain(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ ` +
        'https://view.officeapps.live.com; '
    )
  })

  it('puts a brand’s frame-src in the enforced header and the reported policy alike', () => {
    brandConfig.csp = { 'frame-src': ['https://map.example.jp'] }
    const headers = proxy(new NextRequest(`${ORIGIN}/`)).headers
    const frameSrc =
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ ` +
      'https://map.example.jp'
    expect(headers.get('content-security-policy')).toBe(frameSrc)
    expect(headers.get('content-security-policy-report-only')).toContain(`${frameSrc}; `)
  })

  it('lets development evaluate code, and production not', () => {
    vi.stubEnv('CSP_MODE', 'enforce')
    expect(cspFor(`${ORIGIN}/`)).not.toContain("'unsafe-eval'")
    vi.stubEnv('NODE_ENV', 'development')
    expect(cspFor(`${ORIGIN}/`)).toContain("'unsafe-eval'")
  })

  it('leaves the boot page’s own policy alone whatever the mode', () => {
    vi.stubEnv('CSP_MODE', 'enforce')
    const headers = proxy(new NextRequest(`${ORIGIN}${IBIS_OFFICE_BOOT}`)).headers
    expect(headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts; /)
    expect(headers.get('content-security-policy-report-only')).toBeNull()
  })
})

describe('proxy: uploads', () => {
  it('lets the browser PUT an upload to the storage endpoint', () => {
    vi.stubEnv('CSP_MODE', 'enforce')
    vi.stubEnv('S3_ENDPOINT', 'http://localhost:9000')
    expect(cspFor(`${ORIGIN}/dashboard`)).toContain("connect-src 'self' http://localhost:9000; ")
  })
})
