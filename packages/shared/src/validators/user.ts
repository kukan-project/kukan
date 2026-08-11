/**
 * KUKAN User Validators
 * CKAN-compatible user validation schemas
 */

import { z } from 'zod'
import {
  passwordLengthSchema,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../password-strength'

/** Reusable slug-style name schema (lowercase alphanumeric, hyphens, underscores, periods) */
export const userNameSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(
    /^[a-z0-9._-]+$/,
    'Name must contain only lowercase letters, numbers, hyphens, underscores, and periods'
  )

/** User roles */
export const USER_ROLES = ['user', 'sysadmin'] as const
export type UserRole = (typeof USER_ROLES)[number]
export const userRoleSchema = z.enum(USER_ROLES)

export const createUserSchema = z.object({
  name: userNameSchema,
  email: z.email().max(200),
  displayName: z.string().optional(),
  // Optional for OIDC users. Length only — guessability needs the dictionaries,
  // so it is scored where the password is set (see `evaluatePassword`)
  password: passwordLengthSchema({
    tooShort: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    tooLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  }).optional(),
})

export const updateUserSchema = createUserSchema.omit({ password: true }).partial()

export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
