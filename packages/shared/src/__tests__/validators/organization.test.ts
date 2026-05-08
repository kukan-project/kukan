import { describe, it, expect } from 'vitest'
import { createOrganizationSchema, updateOrganizationSchema } from '../../validators/organization'

describe('createOrganizationSchema', () => {
  it('should accept valid input', () => {
    const result = createOrganizationSchema.safeParse({ name: 'test-org' })
    expect(result.success).toBe(true)
  })

  it('should reject name shorter than 2 chars', () => {
    const result = createOrganizationSchema.safeParse({ name: 'a' })
    expect(result.success).toBe(false)
  })

  it('should reject name with uppercase', () => {
    const result = createOrganizationSchema.safeParse({ name: 'TestOrg' })
    expect(result.success).toBe(false)
  })

  it('should accept optional title and description', () => {
    const result = createOrganizationSchema.safeParse({
      name: 'my-org',
      title: 'My Organization',
      description: 'A test org',
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid imageUrl', () => {
    const result = createOrganizationSchema.safeParse({
      name: 'my-org',
      imageUrl: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('should default extras to empty object', () => {
    const result = createOrganizationSchema.safeParse({ name: 'my-org' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extras).toEqual({})
    }
  })
})

describe('updateOrganizationSchema', () => {
  it('should require name', () => {
    expect(updateOrganizationSchema.safeParse({}).success).toBe(false)
    expect(updateOrganizationSchema.safeParse({ name: 'test-org' }).success).toBe(true)
  })

  it('should accept null for nullable fields (PUT with API response)', () => {
    const result = updateOrganizationSchema.safeParse({
      name: 'test-org',
      title: null,
      description: null,
      imageUrl: null,
    })
    expect(result.success).toBe(true)
  })
})
