/**
 * KUKAN Organization Validators
 * CKAN-compatible organization validation schemas
 */

import { z } from 'zod'
import { slugNameSchema } from './package'

export const createOrganizationSchema = z.object({
  name: slugNameSchema,
  title: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.union([z.url(), z.literal('')]).nullish(),
  extras: z.record(z.string(), z.unknown()).default({}),
})

export const updateOrganizationSchema = createOrganizationSchema

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
