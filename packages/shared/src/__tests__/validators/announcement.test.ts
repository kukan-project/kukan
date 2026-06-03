import { describe, it, expect } from 'vitest'
import { createAnnouncementSchema } from '../../validators/announcement'

describe('createAnnouncementSchema', () => {
  it('should accept valid input with all fields', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'System maintenance',
      category: 'maintenance',
      link: 'https://example.com/details',
      publishedAt: '2026-06-02T10:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  it('should accept minimal input (title only)', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'Hello' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('info')
      expect(result.data.link).toBeUndefined()
      expect(result.data.publishedAt).toBeUndefined()
    }
  })

  it('should reject empty title', () => {
    const result = createAnnouncementSchema.safeParse({ title: '' })
    expect(result.success).toBe(false)
  })

  it('should reject title exceeding 500 chars', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'a'.repeat(501) })
    expect(result.success).toBe(false)
  })

  it('should reject invalid category', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'Test', category: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('should accept all valid categories', () => {
    for (const cat of ['info', 'maintenance', 'release', 'important']) {
      const result = createAnnouncementSchema.safeParse({ title: 'Test', category: cat })
      expect(result.success).toBe(true)
    }
  })

  it('should accept empty string link as nullish', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'Test', link: '' })
    expect(result.success).toBe(true)
  })

  it('should reject invalid URL for link', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'Test', link: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('should reject javascript: URL for link (XSS prevention)', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'Test',
      link: 'javascript:alert(1)',
    })
    expect(result.success).toBe(false)
  })

  it('should reject data: URL for link', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'Test',
      link: 'data:text/html,<script>alert(1)</script>',
    })
    expect(result.success).toBe(false)
  })

  it('should accept https URL for link', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'Test',
      link: 'https://example.com/news',
    })
    expect(result.success).toBe(true)
  })

  it('should accept http URL for link', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'Test',
      link: 'http://example.com/news',
    })
    expect(result.success).toBe(true)
  })

  it('should accept null publishedAt (draft)', () => {
    const result = createAnnouncementSchema.safeParse({ title: 'Test', publishedAt: null })
    expect(result.success).toBe(true)
  })

  it('should coerce date string to Date for publishedAt', () => {
    const result = createAnnouncementSchema.safeParse({
      title: 'Test',
      publishedAt: '2026-06-02T10:00:00Z',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.publishedAt).toBeInstanceOf(Date)
    }
  })
})
