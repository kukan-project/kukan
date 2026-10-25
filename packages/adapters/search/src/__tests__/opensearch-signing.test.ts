import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenSearchAdapter } from '../opensearch'

// The real client against a local server: what reaches the wire is the point.
describe('OpenSearchAdapter request signing', () => {
  let server: Server
  let endpoint: string
  let received: IncomingHttpHeaders[]

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(req.headers)
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ count: 0 }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    received = []
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAPROBE')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'probe-secret')
    vi.stubEnv('AWS_SESSION_TOKEN', 'probe-token')
    return () => {
      vi.unstubAllEnvs()
    }
  })

  it('signs with SigV4 for the region, as the credentials in the environment', async () => {
    const adapter = new OpenSearchAdapter({ endpoint, awsRegion: 'ap-northeast-1' })
    await adapter.getPackagesDocCount()

    expect(received.length).toBeGreaterThan(0)
    for (const headers of received) {
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAPROBE\/\d{8}\/ap-northeast-1\/es\/aws4_request, /
      )
      expect(headers['x-amz-security-token']).toBe('probe-token')
      expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('sends requests unsigned without a region', async () => {
    const adapter = new OpenSearchAdapter({ endpoint })
    await adapter.getPackagesDocCount()

    expect(received.length).toBeGreaterThan(0)
    for (const headers of received) expect(headers.authorization).toBeUndefined()
  })
})
