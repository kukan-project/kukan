import { describe, it, expect } from 'vitest'
import { createGroupSchema, updateGroupSchema } from '../../validators/group'

describe('createGroupSchema', () => {
  it('should accept valid input', () => {
    const result = createGroupSchema.safeParse({ name: 'test-group' })
    expect(result.success).toBe(true)
  })

  it('should reject invalid name pattern', () => {
    const result = createGroupSchema.safeParse({ name: 'Test Group!' })
    expect(result.success).toBe(false)
  })

  it('should accept optional fields', () => {
    const result = createGroupSchema.safeParse({
      name: 'my-group',
      title: 'My Group',
      description: 'A test group',
      image_url: 'https://example.com/image.png',
    })
    expect(result.success).toBe(true)
  })

  it('should default extras to empty object', () => {
    const result = createGroupSchema.safeParse({ name: 'my-group' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extras).toEqual({})
    }
  })
})

describe('updateGroupSchema', () => {
  it('should allow all fields to be optional', () => {
    const result = updateGroupSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})
