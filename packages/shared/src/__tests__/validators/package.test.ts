import { describe, it, expect } from 'vitest'
import { createPackageSchema, updatePackageSchema } from '../../validators/package'

const TEST_ORG_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('createPackageSchema', () => {
  describe('name', () => {
    it('should accept valid lowercase name with hyphens', () => {
      const result = createPackageSchema.safeParse({ name: 'my-dataset', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(true)
    })

    it('should accept name with underscores', () => {
      const result = createPackageSchema.safeParse({ name: 'my_dataset', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(true)
    })

    it('should accept name with numbers', () => {
      const result = createPackageSchema.safeParse({ name: 'dataset-2024', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(true)
    })

    it('should reject name shorter than 2 chars', () => {
      const result = createPackageSchema.safeParse({ name: 'a', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(false)
    })

    it('should reject name longer than 100 chars', () => {
      const result = createPackageSchema.safeParse({
        name: 'a'.repeat(101),
        ownerOrg: TEST_ORG_ID,
      })
      expect(result.success).toBe(false)
    })

    it('should reject name with uppercase letters', () => {
      const result = createPackageSchema.safeParse({ name: 'MyDataset', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(false)
    })

    it('should reject name with spaces', () => {
      const result = createPackageSchema.safeParse({ name: 'my dataset', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(false)
    })

    it('should reject name with special chars', () => {
      const result = createPackageSchema.safeParse({ name: 'my@dataset', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(false)
    })
  })

  describe('minimal input', () => {
    it('should accept name + ownerOrg input with defaults', () => {
      const result = createPackageSchema.safeParse({ name: 'test-pkg', ownerOrg: TEST_ORG_ID })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.private).toBe(false)
        expect(result.data.type).toBe('dataset')
        expect(result.data.extras).toEqual({})
        expect(result.data.tags).toEqual([])
        expect(result.data.resources).toEqual([])
      }
    })

    it('should reject input without ownerOrg', () => {
      const result = createPackageSchema.safeParse({ name: 'test-pkg' })
      expect(result.success).toBe(false)
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
        licenseId: 'cc-by',
        author: 'Test Author',
        authorEmail: 'test@example.com',
        maintainer: 'Maintainer',
        maintainerEmail: 'maint@example.com',
        ownerOrg: '550e8400-e29b-41d4-a716-446655440000',
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
        ownerOrg: TEST_ORG_ID,
        authorEmail: 'not-an-email',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid url', () => {
      const result = createPackageSchema.safeParse({
        name: 'test',
        ownerOrg: TEST_ORG_ID,
        url: 'not-a-url',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid ownerOrg UUID', () => {
      const result = createPackageSchema.safeParse({
        name: 'test',
        ownerOrg: 'not-a-uuid',
      })
      expect(result.success).toBe(false)
    })
  })
})

describe('updatePackageSchema', () => {
  it('should require name and ownerOrg', () => {
    expect(updatePackageSchema.safeParse({}).success).toBe(false)
    expect(
      updatePackageSchema.safeParse({
        name: 'test-pkg',
        ownerOrg: 'a0000000-0000-4000-a000-000000000001',
      }).success
    ).toBe(true)
  })

  it('should validate provided fields', () => {
    const result = updatePackageSchema.safeParse({ name: 'A', ownerOrg: 'not-uuid' })
    expect(result.success).toBe(false)
  })

  it('should accept null for nullable fields (PUT with API response)', () => {
    const result = updatePackageSchema.safeParse({
      name: 'test-pkg',
      ownerOrg: 'a0000000-0000-4000-a000-000000000001',
      title: null,
      notes: null,
      licenseId: null,
      author: null,
      authorEmail: null,
    })
    expect(result.success).toBe(true)
  })
})
