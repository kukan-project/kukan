/**
 * KUKAN Better Auth Configuration
 * Authentication instance with Drizzle adapter
 */

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Database } from '@kukan/db'

export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // Phase 1: disable email verification for development
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Update session every 24 hours
    },
    // Phase 5: Add OIDC plugin for government SSO
  })
}

export type Auth = ReturnType<typeof createAuth>
