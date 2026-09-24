/**
 * KUKAN Group Validators
 * CKAN-compatible group validation schemas
 */

import { z } from 'zod'
import { slugNameSchema } from './package'

export const createGroupSchema = z.object({
  name: slugNameSchema,
  title: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.union([z.url(), z.literal('')]).nullish(),
  extras: z.record(z.string(), z.unknown()).default({}),
})

export const updateGroupSchema = createGroupSchema

export type CreateGroupInput = z.infer<typeof createGroupSchema>
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>
