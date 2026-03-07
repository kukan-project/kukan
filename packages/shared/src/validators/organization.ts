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
      /^[a-z0-9-_]+$/,
      'Name must contain only lowercase letters, numbers, hyphens, and underscores'
    ),
  title: z.string().optional(),
  description: z.string().optional(),
  image_url: z.string().url().optional(),
  extras: z.record(z.unknown()).default({}),
})

export const updateOrganizationSchema = createOrganizationSchema.partial()

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
