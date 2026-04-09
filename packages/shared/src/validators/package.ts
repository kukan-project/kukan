/**
 * KUKAN Package (Dataset) Validators
 * CKAN-compatible package validation schemas
 */

import { z } from 'zod'

export const createPackageSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-z0-9._-]+$/,
      'Name must contain only lowercase letters, numbers, hyphens, underscores, and periods'
    ),
  title: z.string().optional(),
  notes: z.string().optional(),
  url: z.union([z.string().url(), z.literal('')]).optional(),
  version: z.string().max(100).optional(),
  license_id: z.string().max(100).optional(),
  author: z.string().optional(),
  author_email: z.union([z.string().email(), z.literal('')]).optional(),
  maintainer: z.string().optional(),
  maintainer_email: z.union([z.string().email(), z.literal('')]).optional(),
  owner_org: z.string().uuid(),
  private: z.boolean().default(false),
  type: z.string().max(100).default('dataset'),
  extras: z.record(z.unknown()).default({}),
  tags: z.array(z.object({ name: z.string() })).default([]),
  resources: z
    .array(
      z.object({
        url: z.string().url().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        format: z.string().optional(),
        mimetype: z.string().optional(),
      })
    )
    .default([]),
})

export const updatePackageSchema = createPackageSchema.partial().extend({
  state: z.enum(['active', 'deleted']).optional(),
})
export const patchPackageSchema = updatePackageSchema

export type CreatePackageInput = z.infer<typeof createPackageSchema>
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>
export type PatchPackageInput = z.infer<typeof patchPackageSchema>
