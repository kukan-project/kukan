/**
 * KUKAN Group Validators
 * CKAN-compatible group validation schemas
 */

import { z } from 'zod'

export const createGroupSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-z0-9-_]+$/,
      'Name must contain only lowercase letters, numbers, hyphens, and underscores'
    ),
  title: z.string().optional(),
  description: z.string().optional(),
  image_url: z.string().url().optional(),
  extras: z.record(z.unknown()).default({}),
})

export const updateGroupSchema = createGroupSchema.partial()

export type CreateGroupInput = z.infer<typeof createGroupSchema>
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>
