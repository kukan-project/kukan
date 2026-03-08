import { describe, it, expect } from 'vitest'
import { createResourceSchema, updateResourceSchema } from '../../validators/resource'

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

  it('should reject invalid url', () => {
    const result = createResourceSchema.safeParse({
      package_id: validUuid,
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
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
