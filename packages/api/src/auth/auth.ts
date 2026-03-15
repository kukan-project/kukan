/**
 * KUKAN Better Auth Configuration
 */

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { adminAc } from 'better-auth/plugins/admin/access'
import type { Database } from '@kukan/db'

export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
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
    plugins: [
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
