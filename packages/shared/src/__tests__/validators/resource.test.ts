import { describe, it, expect } from 'vitest'
import {
  createResourceSchema,
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  reorderResourcesSchema,
  normalizeSection,
  splitSection,
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
  // version create gates on the hash, so a supplied value would decide whether
  // versions are ever created.
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

  // The address table lives in `__tests__/url.test.ts`, beside the predicate.
  // What is left here is only what `refineUrl` adds on top of it: which path the
  // issue lands on, and which of its two messages a refusal maps to.
  it('should map an unsafe address to an issue on the url path', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'http://127.0.0.1/',
    })

    expect(result.success).toBe(false)
    const issue = result.error!.issues[0]
    expect(issue.path).toEqual(['url'])
    expect(issue.message).toBe('URL points to a private or reserved address')
  })

  it('should map a refused scheme to its own message', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'ftp://example.com/data.csv',
    })

    expect(result.success).toBe(false)
    expect(result.error!.issues[0].message).toBe('Only http and https URLs are allowed')
  })

  it('should allow public URLs', () => {
    const result = createResourceSchema.safeParse({
      packageId: validUuid,
      url: 'https://example.com/data.csv',
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

describe('normalizeSection', () => {
  it('should trim each segment', () => {
    expect(normalizeSection('  2024 / 東京都 ')).toBe('2024/東京都')
  })

  it('should drop empty segments', () => {
    expect(normalizeSection('/docs//raw/')).toBe('docs/raw')
  })

  it('should collapse everything that means "no section" to null', () => {
    for (const value of ['', '   ', '/', '//', ' / ', null, undefined]) {
      expect(normalizeSection(value)).toBeNull()
    }
  })

  it('should leave an already normalized label alone', () => {
    expect(normalizeSection('docs')).toBe('docs')
  })
})

describe('resource section field', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000'

  it('should normalize section on create', () => {
    const result = createResourceSchema.safeParse({ packageId: validUuid, section: ' docs / raw ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.section).toBe('docs/raw')
  })

  it('should leave section absent when it is not sent', () => {
    const result = createResourceSchema.safeParse({ packageId: validUuid })
    expect(result.success).toBe(true)
    if (result.success) expect('section' in result.data).toBe(false)
  })

  it('should accept an explicit null as clearing the section', () => {
    const result = updateResourceSchema.safeParse({ section: null })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.section).toBeNull()
  })
})

describe('reorderResourcesSchema', () => {
  const idA = '550e8400-e29b-41d4-a716-446655440000'
  const idB = '550e8400-e29b-41d4-a716-446655440001'

  it('should accept a body that only reorders', () => {
    const result = reorderResourcesSchema.safeParse({ resourceIds: [idA, idB] })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.sections).toBeUndefined()
  })

  it('should normalize the sections it carries', () => {
    const result = reorderResourcesSchema.safeParse({
      resourceIds: [idA, idB],
      sections: [
        { resourceId: idA, section: ' docs ' },
        { resourceId: idB, section: null },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sections).toEqual([
        { resourceId: idA, section: 'docs' },
        { resourceId: idB, section: null },
      ])
    }
  })

  it('should reject a section entry without a section', () => {
    const result = reorderResourcesSchema.safeParse({
      resourceIds: [idA],
      sections: [{ resourceId: idA }],
    })
    expect(result.success).toBe(false)
  })
})

describe('splitSection', () => {
  it('accepts one contiguous run per name, root rows between names included', () => {
    expect(splitSection(['a', 'a', null, 'b', 'b'])).toBeNull()
    expect(splitSection([null, null])).toBeNull()
    expect(splitSection([])).toBeNull()
  })

  it('names the first label that comes back after another label or the root', () => {
    expect(splitSection(['a', 'b', 'a'])).toBe('a')
    expect(splitSection(['a', null, 'a'])).toBe('a')
    expect(splitSection(['x', 'a', 'a', 'b', 'x'])).toBe('x')
  })
})
