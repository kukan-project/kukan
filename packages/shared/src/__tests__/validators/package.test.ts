import { describe, it, expect } from 'vitest'
import {
  createPackageSchema,
  updatePackageSchema,
  patchPackageSchema,
} from '../../validators/package'

describe('createPackageSchema', () => {
  describe('name', () => {
    it('should accept valid lowercase name with hyphens', () => {
      const result = createPackageSchema.safeParse({ name: 'my-dataset' })
      expect(result.success).toBe(true)
    })

    it('should accept name with underscores', () => {
      const result = createPackageSchema.safeParse({ name: 'my_dataset' })
      expect(result.success).toBe(true)
    })

    it('should accept name with numbers', () => {
      const result = createPackageSchema.safeParse({ name: 'dataset-2024' })
      expect(result.success).toBe(true)
    })

    it('should reject name shorter than 2 chars', () => {
      const result = createPackageSchema.safeParse({ name: 'a' })
      expect(result.success).toBe(false)
    })

    it('should reject name longer than 100 chars', () => {
      const result = createPackageSchema.safeParse({ name: 'a'.repeat(101) })
      expect(result.success).toBe(false)
    })

    it('should reject name with uppercase letters', () => {
      const result = createPackageSchema.safeParse({ name: 'MyDataset' })
      expect(result.success).toBe(false)
    })

    it('should reject name with spaces', () => {
      const result = createPackageSchema.safeParse({ name: 'my dataset' })
      expect(result.success).toBe(false)
    })

    it('should reject name with special chars', () => {
      const result = createPackageSchema.safeParse({ name: 'my@dataset' })
      expect(result.success).toBe(false)
    })
  })

  describe('minimal input', () => {
    it('should accept name-only input with defaults', () => {
      const result = createPackageSchema.safeParse({ name: 'test-pkg' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.private).toBe(false)
        expect(result.data.type).toBe('dataset')
        expect(result.data.extras).toEqual({})
        expect(result.data.tags).toEqual([])
        expect(result.data.resources).toEqual([])
      }
    })
  })

  describe('optional fields', () => {
    it('should accept all fields', () => {
      const result = createPackageSchema.safeParse({
        name: 'full-dataset',
        title: 'Full Dataset',
        notes: 'Description here',
        url: 'https://example.com',
        version: '1.0.0',
        license_id: 'cc-by',
        author: 'Test Author',
        author_email: 'test@example.com',
        maintainer: 'Maintainer',
        maintainer_email: 'maint@example.com',
        owner_org: '550e8400-e29b-41d4-a716-446655440000',
        private: true,
        type: 'dataset',
        extras: { key: 'value' },
        tags: [{ name: 'open-data' }],
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid email', () => {
      const result = createPackageSchema.safeParse({
        name: 'test',
        author_email: 'not-an-email',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid url', () => {
      const result = createPackageSchema.safeParse({
        name: 'test',
        url: 'not-a-url',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid owner_org UUID', () => {
      const result = createPackageSchema.safeParse({
        name: 'test',
        owner_org: 'not-a-uuid',
      })
      expect(result.success).toBe(false)
    })
  })
})

describe('updatePackageSchema', () => {
  it('should allow all fields to be optional', () => {
    const result = updatePackageSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should validate provided fields', () => {
    const result = updatePackageSchema.safeParse({ name: 'A' })
    expect(result.success).toBe(false)
  })
})

describe('patchPackageSchema', () => {
  it('should allow all fields to be optional', () => {
    const result = patchPackageSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})
