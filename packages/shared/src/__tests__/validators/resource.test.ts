import { describe, it, expect } from 'vitest'
import {
  createResourceSchema,
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
} from '../../validators/resource'

describe('createResourceSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000'

  it('should require package_id as UUID', () => {
    const result = createResourceSchema.safeParse({ package_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('should reject invalid UUID for package_id', () => {
    const result = createResourceSchema.safeParse({ package_id: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('should reject missing package_id', () => {
    const result = createResourceSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should accept optional url, name, format', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      url: 'https://example.com/data.csv',
      name: 'My Resource',
      format: 'CSV',
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid url when url_type is not upload', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('should accept filename as url when url_type is upload', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      url: 'data.csv',
      url_type: 'upload',
    })
    expect(result.success).toBe(true)
  })

  it('should accept valid positive size', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      size: 1024,
    })
    expect(result.success).toBe(true)
  })

  it('should reject negative size', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      size: -1,
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer size', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      size: 1.5,
    })
    expect(result.success).toBe(false)
  })

  it('should default extras to empty object', () => {
    const result = createResourceSchema.safeParse({ package_id: validUuid })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extras).toEqual({})
    }
  })
})

describe('updateResourceSchema', () => {
  it('should not include package_id', () => {
    const result = updateResourceSchema.safeParse({
      package_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('package_id' in result.data).toBe(false)
    }
  })

  it('should allow all fields to be optional', () => {
    const result = updateResourceSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('uploadUrlSchema', () => {
  it('should accept valid input', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      content_type: 'text/csv',
    })
    expect(result.success).toBe(true)
  })

  it('should accept input with optional format', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      content_type: 'text/csv',
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
      content_type: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing filename', () => {
    const result = uploadUrlSchema.safeParse({
      content_type: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty content_type', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      content_type: '',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing content_type', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject filename exceeding 500 chars', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'a'.repeat(501),
      content_type: 'text/csv',
    })
    expect(result.success).toBe(false)
  })

  it('should reject format exceeding 100 chars', () => {
    const result = uploadUrlSchema.safeParse({
      filename: 'data.csv',
      content_type: 'text/csv',
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
