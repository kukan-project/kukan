import { describe, it, expect } from 'vitest'
import {
  createResourceSchema,
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
} from '../../validators/resource'

describe('createResourceSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000'

  it('should require packageId as UUID', () => {
    const result = createResourceSchema.safeParse({ packageId: validUuid })
    expect(result.success).toBe(true)
  })

  it('should reject invalid UUID for packageId', () => {
    const result = createResourceSchema.safeParse({ packageId: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('should reject missing packageId', () => {
    const result = createResourceSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should accept optional url, name, format', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'https://example.com/data.csv',
      name: 'My Resource',
      format: 'CSV',
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid url when urlType is not upload', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('should accept filename as url when urlType is upload', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'data.csv',
      urlType: 'upload',
    })
    expect(result.success).toBe(true)
  })

  // size/hash are measured by the pipeline, not accepted from callers (ADR-043):
  // version capture gates on the hash, so a supplied value would decide whether
  // versions are ever captured.
  it('ignores a caller-supplied size and hash', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      size: -1,
      hash: 'sha256:whatever',
    })
    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty('size')
    expect(result.data).not.toHaveProperty('hash')
  })

  it('should not include extras (system-managed)', () => {
    const result = createResourceSchema.safeParse({ packageId: validUuid })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('extras' in result.data).toBe(false)
    }
  })

  it('should reject loopback and link-local IPv4 URLs', () => {
    const blockedUrls = ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/']
    for (const url of blockedUrls) {
      const result = createResourceSchema.safeParse({ packageId: validUuid, url })
      expect(result.success, `expected ${url} to be rejected`).toBe(false)
    }
  })

  it('should allow private network IPv4 URLs for intranet use', () => {
    const allowedUrls = ['http://10.0.0.1/data', 'http://192.168.1.1/api', 'http://172.16.0.1/']
    for (const url of allowedUrls) {
      const result = createResourceSchema.safeParse({ packageId: validUuid, url })
      expect(result.success, `expected ${url} to be allowed`).toBe(true)
    }
  })

  it('should reject loopback and link-local IPv6 URLs', () => {
    const blockedUrls = [
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fe90::1]/',
      'http://[febf::1]/',
    ]
    for (const url of blockedUrls) {
      const result = createResourceSchema.safeParse({ packageId: validUuid, url })
      expect(result.success, `expected ${url} to be rejected`).toBe(false)
    }
  })

  it('should allow ULA IPv6 URLs for intranet use', () => {
    const allowedUrls = ['http://[fc00::1]/', 'http://[fd00::1]/']
    for (const url of allowedUrls) {
      const result = createResourceSchema.safeParse({ packageId: validUuid, url })
      expect(result.success, `expected ${url} to be allowed`).toBe(true)
    }
  })

  it('should reject localhost', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'http://localhost/data',
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-http(s) URLs', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'ftp://example.com/data',
    })
    expect(result.success).toBe(false)
  })

  it('should allow public URLs', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'https://data.example.com/dataset.csv',
    })
    expect(result.success).toBe(true)
  })

  it('should strip state from input', () => {
    const result = createResourceSchema.safeParse({ packageId: validUuid, state: 'deleted' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('state' in result.data).toBe(false)
    }
  })
})

describe('updateResourceSchema', () => {
  it('should not include packageId', () => {
    const result = updateResourceSchema.safeParse({
      packageId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('packageId' in result.data).toBe(false)
    }
  })

  it('should allow all fields to be optional', () => {
    const result = updateResourceSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should accept null for nullable fields (PUT with API response)', () => {
    const result = updateResourceSchema.safeParse({
      name: null,
      description: null,
      format: null,
      mimetype: null,
      resourceType: null,
      url: null,
      urlType: null,
    })
    expect(result.success).toBe(true)
  })
})

describe('uploadUrlSchema', () => {
  it('should accept valid input', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    expect(result.success).toBe(true)
  })

  it('should accept input with optional format', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      contentType: 'text/csv',
      format: 'CSV',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.format).toBe('CSV')
    }
  })

  it('should reject empty filename', () => {
    const result = uploadUrlSchema.safeParse({
      filename: '',
      contentType: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing filename', () => {
    const result = uploadUrlSchema.safeParse({
      contentType: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty contentType', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      contentType: '',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing contentType', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject filename exceeding 500 chars', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'a'.repeat(501),
      contentType: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject format exceeding 100 chars', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      contentType: 'text/csv',
      format: 'X'.repeat(101),
    })
    expect(result.success).toBe(false)
  })
})

describe('uploadCompleteSchema', () => {
  it('should accept empty object', () => {
    const result = uploadCompleteSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should accept size and hash', () => {
    const result = uploadCompleteSchema.safeParse({
      size: 1024,
      hash: 'sha256:abc123',
    })
    expect(result.success).toBe(true)
  })

  it('should accept size only', () => {
    const result = uploadCompleteSchema.safeParse({ size: 1024 })
    expect(result.success).toBe(true)
  })

  it('should accept hash only', () => {
    const result = uploadCompleteSchema.safeParse({ hash: 'sha256:abc123' })
    expect(result.success).toBe(true)
  })

  it('should reject negative size', () => {
    const result = uploadCompleteSchema.safeParse({ size: -1 })
    expect(result.success).toBe(false)
  })

  it('should reject zero size', () => {
    const result = uploadCompleteSchema.safeParse({ size: 0 })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer size', () => {
    const result = uploadCompleteSchema.safeParse({ size: 1.5 })
    expect(result.success).toBe(false)
  })
})
