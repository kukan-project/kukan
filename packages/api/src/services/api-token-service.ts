/**
 * KUKAN API Token Service
 * Create, list, revoke, and validate API tokens
 */

import { randomBytes, createHash } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { apiToken, user } from '@kukan/db'
import { NotFoundError } from '@kukan/shared'

const TOKEN_PREFIX = 'kukan_'
const TOKEN_BYTES = 32

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex')
}

export interface CreateApiTokenInput {
  name?: string
  expiresAt?: Date
}

export class ApiTokenService {
  constructor(private db: Database) {}

  /**
   * Create a new API token for a user.
   * Returns the raw token (only shown once) and the token metadata.
   */
  async create(userId: string, input: CreateApiTokenInput) {
    const rawToken = generateToken()
    const tokenHash = hashToken(rawToken)

    const [created] = await this.db
      .insert(apiToken)
      .values({
        userId,
        name: input.name || null,
        tokenHash,
        expiresAt: input.expiresAt || null,
      })
      .returning()

    return {
      id: created.id,
      name: created.name,
      token: rawToken, // Only returned at creation time
      expiresAt: created.expiresAt,
      created: created.created,
    }
  }

  /**
   * List all active tokens for a user (without hashes).
   */
  async listByUser(userId: string) {
    const tokens = await this.db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        lastUsed: apiToken.lastUsed,
        expiresAt: apiToken.expiresAt,
        created: apiToken.created,
      })
      .from(apiToken)
      .where(eq(apiToken.userId, userId))

    return tokens
  }

  /**
   * Revoke (delete) an API token.
   */
  async revoke(tokenId: string, userId: string) {
    const [existing] = await this.db
      .select()
      .from(apiToken)
      .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, userId)))
      .limit(1)

    if (!existing) {
      throw new NotFoundError('API Token', tokenId)
    }

    await this.db.delete(apiToken).where(eq(apiToken.id, tokenId))

    return { success: true }
  }

  /**
   * Validate a raw API token. Returns the user if valid, null otherwise.
   */
  async validate(rawToken: string) {
    const tokenHash = hashToken(rawToken)

    const [result] = await this.db
      .select({
        tokenId: apiToken.id,
        userId: apiToken.userId,
        expiresAt: apiToken.expiresAt,
        email: user.email,
        name: user.name,
        role: user.role,
      })
      .from(apiToken)
      .innerJoin(user, eq(apiToken.userId, user.id))
      .where(eq(apiToken.tokenHash, tokenHash))
      .limit(1)

    if (!result) {
      return null
    }

    // Check expiration
    if (result.expiresAt && result.expiresAt < new Date()) {
      return null
    }

    // Update last_used timestamp
    await this.db
      .update(apiToken)
      .set({ lastUsed: new Date() })
      .where(eq(apiToken.id, result.tokenId))

    return {
      id: result.userId,
      email: result.email,
      name: result.name,
      sysadmin: result.role === 'sysadmin',
    }
  }
}
