import { describe, it, expect } from 'vitest'
import { createUserSchema } from '../validators/user'

describe('createUserSchema', () => {
  const valid = (name: string) =>
    createUserSchema.safeParse({ name, email: 'a@b.com', password: '12345678' })

  describe('name validation', () => {
    it('should accept lowercase alphanumeric with hyphens and underscores', () => {
      expect(valid('john-doe').success).toBe(true)
      expect(valid('user_123').success).toBe(true)
      expect(valid('ab').success).toBe(true)
    })

    it('should reject uppercase letters', () => {
      expect(valid('John').success).toBe(false)
      expect(valid('ADMIN').success).toBe(false)
    })

    it('should reject spaces', () => {
      expect(valid('john doe').success).toBe(false)
    })

    it('should reject special characters', () => {
      expect(valid('user@name').success).toBe(false)
      expect(valid('user/name').success).toBe(false)
    })

    it('should allow periods', () => {
      expect(valid('user.name').success).toBe(true)
      expect(valid('john.doe').success).toBe(true)
    })

    it('should reject non-ASCII characters', () => {
      expect(valid('山田太郎').success).toBe(false)
      expect(valid('taro-山田').success).toBe(false)
    })

    it('should reject names shorter than 2 characters', () => {
      expect(valid('a').success).toBe(false)
    })

    it('should reject names longer than 100 characters', () => {
      expect(valid('a'.repeat(101)).success).toBe(false)
    })

    it('should accept names at boundary lengths', () => {
      expect(valid('ab').success).toBe(true)
      expect(valid('a'.repeat(100)).success).toBe(true)
    })
  })

  describe('email validation', () => {
    it('should accept valid emails', () => {
      expect(
        createUserSchema.safeParse({
          name: 'test',
          email: 'user@example.com',
          password: '12345678',
        }).success
      ).toBe(true)
    })

    it('should reject invalid emails', () => {
      expect(
        createUserSchema.safeParse({ name: 'test', email: 'not-an-email', password: '12345678' })
          .success
      ).toBe(false)
    })
  })

  describe('password validation', () => {
    it('should accept passwords of 8+ characters', () => {
      expect(
        createUserSchema.safeParse({ name: 'test', email: 'a@b.com', password: '12345678' }).success
      ).toBe(true)
    })

    it('should reject passwords shorter than 8 characters', () => {
      expect(
        createUserSchema.safeParse({ name: 'test', email: 'a@b.com', password: '1234567' }).success
      ).toBe(false)
    })

    it('should allow password to be omitted (OIDC users)', () => {
      expect(createUserSchema.safeParse({ name: 'test', email: 'a@b.com' }).success).toBe(true)
    })
  })
})
