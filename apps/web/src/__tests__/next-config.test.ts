import { describe, it, expect } from 'vitest'
import nextConfig from '../../next.config'

describe('next.config', () => {
  it('sends no X-Powered-By, which names the framework to anyone asking (ADR-070)', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  it('turns the image optimizer off, so /_next/image fetches no URL a request names', () => {
    expect(nextConfig.images?.unoptimized).toBe(true)
  })
})
