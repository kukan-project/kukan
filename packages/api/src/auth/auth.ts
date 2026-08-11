/**
 * KUKAN Better Auth Configuration
 */

import { sql } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { admin } from 'better-auth/plugins'
import { adminAc } from 'better-auth/plugins/admin/access'
import type { Database } from '@kukan/db'
import { auditLog } from '@kukan/db'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@kukan/shared'
import { claimBootstrapPromotion } from '../services/bootstrap'
import { enforcePasswordPolicy } from './password-policy'

export function createAuth(db: Database) {
  // Links the before-hook promotion decision to the after-hook audit write.
  // Safe as a closure flag: bootstrap promotes at most one user per process.
  let bootstrapPromotion = false
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Stated rather than left to the default, because the strength hook skips
      // anything longer and relies on this check to refuse it
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    hooks: {
      before: enforcePasswordPolicy,
    },
    user: {
      additionalFields: {
        // Better Auth drops columns it was not told about, so a displayName
        // handed to createUser never reached the row without this. `input:
        // false` keeps the declaration from also opening /api/auth/update-user,
        // where any signed-in user could otherwise name themselves anything;
        // KUKAN's own admin API decides who may set it. Server-side creation is
        // unaffected.
        displayName: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // First sign-up on an empty user table becomes sysadmin (ADR-038);
          // the claim's unique key makes this race-safe under concurrent
          // sign-ups. The admin plugin's before hook merges with priority to
          // incoming data, so this wins regardless of hook execution order.
          before: async (userData) => {
            const claim = await claimBootstrapPromotion(db)
            if (claim === 'claimed') {
              bootstrapPromotion = true
              return { data: { ...userData, role: 'sysadmin' } }
            }
            // While a fresh claim is in flight, creating this user would end
            // bootstrap without a sysadmin if the claim holder died mid-creation.
            // Reject; the claim completes or goes stale within a minute.
            if (claim === 'in-progress') {
              throw new APIError('CONFLICT', {
                message: 'Initial setup is in progress. Please retry in a minute.',
              })
            }
            return undefined
          },
          after: async (createdUser) => {
            // The role check keeps a concurrent non-promoted creation from
            // consuming the flag before the promoted user's hook runs
            if (!bootstrapPromotion || createdUser.role !== 'sysadmin') return
            bootstrapPromotion = false
            // entityId is uuid; Better Auth user IDs are text, so store in changes instead
            await db.insert(auditLog).values({
              entityType: 'user',
              entityId: sql`gen_random_uuid()`,
              action: 'create',
              userId: createdUser.id,
              changes: { userId: createdUser.id, role: 'sysadmin', bootstrap: true },
            })
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: [
      ...(process.env.TRUSTED_ORIGINS ? process.env.TRUSTED_ORIGINS.split(',') : []),
      // Auto-trust Vercel preview URLs (*.vercel.app)
      ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    ],
    rateLimit: {
      enabled: true,
    },
    plugins: [
      // Used for its schema fields (role/banned) and defaultRole only. The
      // plugin's HTTP endpoints under /api/auth/admin/* are blocked in app.ts —
      // keep the two in sync if this plugin config changes.
      admin({
        defaultRole: 'user',
        adminRoles: ['sysadmin'],
        roles: {
          sysadmin: adminAc,
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
