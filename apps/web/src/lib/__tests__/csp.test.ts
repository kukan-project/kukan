import { describe, it, expect } from 'vitest'
import { buildContentSecurityPolicy, OFFICE_ONLINE_VIEWER, uploadOrigin } from '../csp'
import { IBIS_OFFICE_BOOT } from '../ibis-office'

const ORIGIN = 'https://catalog.example.jp'
const base = { origins: [ORIGIN], officeOnline: false, ga: false, dev: false }

function directive(policy: string, name: string): string | undefined {
  return policy
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1)
}

describe('buildContentSecurityPolicy (ADR-071)', () => {
  it('is the default brand’s policy, inline scripts allowed and nothing loaded from elsewhere', () => {
    expect(buildContentSecurityPolicy(base).policy).toBe(
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https: http:; " +
        "font-src 'self' data:; " +
        "connect-src 'self'; " +
        "worker-src 'self'; " +
        `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/; ` +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "frame-ancestors 'self'"
    )
  })

  it('returns what stays enforced under report-only: frame-src and the directives no page uses', () => {
    const { enforced } = buildContentSecurityPolicy(base)
    expect(enforced).toBe(
      `frame-src ${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/; ` +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    )
  })

  it('lets gtag.js load and report, Google signals included, when the brand has GA4', () => {
    const { policy } = buildContentSecurityPolicy({ ...base, ga: true })
    expect(directive(policy, 'script-src')).toBe(
      "'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.googletagmanager.com"
    )
    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://*.google-analytics.com https://*.analytics.google.com " +
        'https://*.googletagmanager.com https://*.g.doubleclick.net https://*.google.com ' +
        'https://*.google.co.jp'
    )
    expect(buildContentSecurityPolicy(base).policy).not.toContain('google')
  })

  it('lets development evaluate code, for Fast Refresh', () => {
    expect(directive(buildContentSecurityPolicy({ ...base, dev: true }).policy, 'script-src')).toBe(
      "'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval'"
    )
    expect(buildContentSecurityPolicy(base).policy).not.toContain("'unsafe-eval'")
  })

  it('frames Microsoft’s viewer on an office-online site alone', () => {
    expect(buildContentSecurityPolicy(base).enforced).not.toContain(OFFICE_ONLINE_VIEWER)
    const { policy, enforced } = buildContentSecurityPolicy({ ...base, officeOnline: true })
    expect(directive(policy, 'frame-src')).toBe(
      `${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ ${OFFICE_ONLINE_VIEWER}`
    )
    expect(directive(enforced, 'frame-src')).toBe(directive(policy, 'frame-src'))
  })

  it('names every origin the proxy found', () => {
    const { policy } = buildContentSecurityPolicy({
      ...base,
      origins: [ORIGIN, 'http://10.0.0.5:3000'],
    })
    expect(directive(policy, 'frame-src')).toBe(
      `${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ ` +
        `http://10.0.0.5:3000${IBIS_OFFICE_BOOT} http://10.0.0.5:3000/api/v1/resources/`
    )
  })

  it('appends a brand’s sources to a directive, and adds one it does not have', () => {
    const { policy } = buildContentSecurityPolicy({
      ...base,
      brandExtra: {
        'connect-src': ['https://api.example.jp'],
        'media-src': ['https://media.example.jp'],
        'font-src': [],
      },
    })
    expect(directive(policy, 'connect-src')).toBe("'self' https://api.example.jp")
    expect(directive(policy, 'media-src')).toBe('https://media.example.jp')
    expect(directive(policy, 'font-src')).toBe("'self' data:")
  })

  it('carries a brand’s frame-src into what stays enforced', () => {
    const { policy, enforced } = buildContentSecurityPolicy({
      ...base,
      brandExtra: { 'frame-src': ['https://map.example.jp'] },
    })
    const frames = `${ORIGIN}${IBIS_OFFICE_BOOT} ${ORIGIN}/api/v1/resources/ https://map.example.jp`
    expect(directive(enforced, 'frame-src')).toBe(frames)
    expect(directive(policy, 'frame-src')).toBe(frames)
  })
})

describe('uploadOrigin', () => {
  it('is the configured endpoint’s origin, as MinIO or S3 reached by name', () => {
    expect(uploadOrigin({ S3_ENDPOINT: 'http://localhost:9000/' })).toBe('http://localhost:9000')
    expect(uploadOrigin({ S3_ENDPOINT: 'https://s3.example.lg.jp', S3_BUCKET: 'b' })).toBe(
      'https://s3.example.lg.jp'
    )
  })

  it('is the bucket’s virtual-hosted address when no endpoint is given', () => {
    expect(uploadOrigin({ S3_BUCKET: 'kukan-prd', S3_REGION: 'ap-northeast-3' })).toBe(
      'https://kukan-prd.s3.ap-northeast-3.amazonaws.com'
    )
    expect(uploadOrigin({ S3_BUCKET: 'kukan-prd' })).toBe(
      'https://kukan-prd.s3.ap-northeast-1.amazonaws.com'
    )
  })

  it('is the regional host for a bucket with a dot, which the SDK puts in the path', () => {
    expect(uploadOrigin({ S3_BUCKET: 'data.example.jp', S3_REGION: 'ap-northeast-3' })).toBe(
      'https://s3.ap-northeast-3.amazonaws.com'
    )
  })

  it('is nothing for an unusable endpoint or no storage at all', () => {
    expect(uploadOrigin({ S3_ENDPOINT: 'not a url' })).toBeUndefined()
    expect(uploadOrigin({})).toBeUndefined()
  })

  it('reaches connect-src, so a browser may PUT its upload there', () => {
    const { policy } = buildContentSecurityPolicy({
      ...base,
      storageOrigin: 'https://kukan-prd.s3.ap-northeast-1.amazonaws.com',
    })
    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://kukan-prd.s3.ap-northeast-1.amazonaws.com"
    )
  })
})
