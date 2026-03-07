/**
 * KUKAN User Validators
 * CKAN-compatible user validation schemas
 */

import { z } from 'zod'

export const createUserSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-z0-9-_]+$/,
      'Name must contain only lowercase letters, numbers, hyphens, and underscores'
    ),
  email: z.string().email().max(200),
  display_name: z.string().optional(),
  password: z.string().min(8).optional(), // Optional for OIDC users
})

export const updateUserSchema = createUserSchema.omit({ password: true }).partial()

export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
