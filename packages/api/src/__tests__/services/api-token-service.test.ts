import { describe, it, expect } from 'vitest'
import { NotFoundError } from '@kukan/shared'
import { createMockDb } from '../test-helpers/mock-db'
import { ApiTokenService } from '../../services/api-token-service'

describe('ApiTokenService', () => {
  describe('create', () => {
    it('should return a raw token with kukan_ prefix', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        {
          id: 'tok-1',
          name: 'My Token',
          expiresAt: null,
          created: new Date('2024-01-01'),
        },
      ])

      const service = new ApiTokenService(db)
      const result = await service.create('user-1', { name: 'My Token' })

      expect(result.token).toMatch(/^kukan_[0-9a-f]{64}$/)
      expect(result.id).toBe('tok-1')
      expect(result.name).toBe('My Token')
    })

    it('should generate unique tokens on each call', async () => {
      const { db, addResult } = createMockDb()
      addResult([{ id: 'tok-1', name: null, expiresAt: null, created: new Date() }])
      addResult([{ id: 'tok-2', name: null, expiresAt: null, created: new Date() }])

      const service = new ApiTokenService(db)
      const r1 = await service.create('user-1', {})
      const r2 = await service.create('user-1', {})

      expect(r1.token).not.toBe(r2.token)
    })

    it('should pass expiresAt to the database', async () => {
      const { db, addResult } = createMockDb()
      const expires = new Date('2025-12-31')
      addResult([{ id: 'tok-1', name: null, expiresAt: expires, created: new Date() }])

      const service = new ApiTokenService(db)
      const result = await service.create('user-1', { expiresAt: expires })

      expect(result.expiresAt).toEqual(expires)
    })
  })

  describe('listByUser', () => {
    it('should return tokens without hash', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        { id: 'tok-1', name: 'Token A', lastUsed: null, expiresAt: null, created: new Date() },
        {
          id: 'tok-2',
          name: 'Token B',
          lastUsed: new Date(),
          expiresAt: null,
          created: new Date(),
        },
      ])

      const service = new ApiTokenService(db)
      const tokens = await service.listByUser('user-1')

      expect(tokens).toHaveLength(2)
      expect(tokens[0]).not.toHaveProperty('tokenHash')
      expect(tokens[0]).toHaveProperty('id')
      expect(tokens[0]).toHaveProperty('name')
    })

    it('should return empty array when user has no tokens', async () => {
      const { db, addResult } = createMockDb()
      addResult([])

      const service = new ApiTokenService(db)
      const tokens = await service.listByUser('user-1')

      expect(tokens).toEqual([])
    })
  })

  describe('revoke', () => {
    it('should delete the token and return success', async () => {
      const { db, addResult } = createMockDb()
      addResult([{ id: 'tok-1', userId: 'user-1' }]) // select finds token
      addResult([]) // delete succeeds

      const service = new ApiTokenService(db)
      const result = await service.revoke('tok-1', 'user-1')

      expect(result).toEqual({ success: true })
    })

    it('should throw NotFoundError when token does not exist', async () => {
      const { db, addResult } = createMockDb()
      addResult([]) // select returns empty

      const service = new ApiTokenService(db)
      await expect(service.revoke('tok-999', 'user-1')).rejects.toThrow(NotFoundError)
    })
  })

  describe('validate', () => {
    it('should return null when token is not found', async () => {
      const { db, addResult } = createMockDb()
      addResult([]) // select returns empty

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_invalid')

      expect(result).toBeNull()
    })

    it('should return null when token is expired', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        {
          tokenId: 'tok-1',
          userId: 'user-1',
          expiresAt: new Date('2020-01-01'), // expired
          email: 'test@example.com',
          name: 'Test User',
          displayName: null,
          role: 'user',
          state: 'active',
        },
      ])

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_sometoken')

      expect(result).toBeNull()
    })

    it('should return user info for valid non-expired token', async () => {
      const { db, addResult } = createMockDb()
      const future = new Date(Date.now() + 86400000) // tomorrow
      addResult([
        {
          tokenId: 'tok-1',
          userId: 'user-1',
          expiresAt: future,
          email: 'test@example.com',
          name: 'Test User',
          displayName: null,
          role: 'user',
          state: 'active',
        },
      ])
      addResult([]) // update lastUsed

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_sometoken')

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        displayName: null,
        sysadmin: false,
      })
    })

    it('should return user info for token with no expiration', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        {
          tokenId: 'tok-1',
          userId: 'user-1',
          expiresAt: null,
          email: 'admin@example.com',
          name: 'Admin',
          displayName: null,
          role: 'sysadmin',
          state: 'active',
        },
      ])
      addResult([]) // update lastUsed

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_sometoken')

      expect(result).toEqual({
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        displayName: null,
        sysadmin: true,
      })
    })

    it('should return null when user state is deleted', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        {
          tokenId: 'tok-1',
          userId: 'user-1',
          expiresAt: null,
          email: 'deleted@example.com',
          name: 'Deleted User',
          displayName: null,
          role: 'user',
          state: 'deleted',
        },
      ])

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_sometoken')

      expect(result).toBeNull()
    })

    it('should set sysadmin flag based on user role', async () => {
      const { db, addResult } = createMockDb()
      addResult([
        {
          tokenId: 'tok-1',
          userId: 'user-1',
          expiresAt: null,
          email: 'a@b.com',
          name: 'SA',
          displayName: null,
          role: 'sysadmin',
          state: 'active',
        },
      ])
      addResult([])

      const service = new ApiTokenService(db)
      const result = await service.validate('kukan_x')

      expect(result?.sysadmin).toBe(true)
    })
  })
})
