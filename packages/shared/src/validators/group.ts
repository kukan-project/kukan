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
      /^[a-z0-9._-]+$/,
      'Name must contain only lowercase letters, numbers, hyphens, underscores, and periods'
    ),
  title: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.union([z.url(), z.literal('')]).nullish(),
  extras: z.record(z.string(), z.unknown()).default({}),
})

export const updateGroupSchema = createGroupSchema

export type CreateGroupInput = z.infer<typeof createGroupSchema>
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>
