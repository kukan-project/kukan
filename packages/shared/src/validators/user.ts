/**
 * KUKAN User Validators
 * CKAN-compatible user validation schemas
 */

import { z } from 'zod'

/** Reusable slug-style name schema (lowercase alphanumeric, hyphens, underscores) */
export const userNameSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(
    /^[a-z0-9_-]+$/,
    'Name must contain only lowercase letters, numbers, hyphens, and underscores'
  )

/** User roles */
export const USER_ROLES = ['user', 'sysadmin'] as const
export type UserRole = (typeof USER_ROLES)[number]
export const userRoleSchema = z.enum(USER_ROLES)

export const createUserSchema = z.object({
  name: userNameSchema,
  email: z.string().email().max(200),
  display_name: z.string().optional(),
  password: z.string().min(8).optional(), // Optional for OIDC users
})

export const updateUserSchema = createUserSchema.omit({ password: true }).partial()

export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
