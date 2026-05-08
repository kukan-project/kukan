/**
 * KUKAN Organization Validators
 * CKAN-compatible organization validation schemas
 */

import { z } from 'zod'

export const createOrganizationSchema = z.object({
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
  state: z.enum(['active', 'deleted']).default('active'),
})

export const updateOrganizationSchema = createOrganizationSchema

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
