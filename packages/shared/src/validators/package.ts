/**
 * KUKAN Package (Dataset) Validators
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
  title: z.string().nullish(),
  notes: z.string().nullish(),
  url: z.union([z.url(), z.literal('')]).nullish(),
  version: z.string().max(100).nullish(),
  licenseId: z.string().max(100).nullish(),
  author: z.string().nullish(),
  authorEmail: z.union([z.email(), z.literal('')]).nullish(),
  maintainer: z.string().nullish(),
  maintainerEmail: z.union([z.email(), z.literal('')]).nullish(),
  ownerOrg: z.uuid(),
  private: z.boolean().default(false),
  type: z.string().max(100).default('dataset'),
  extras: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.object({ name: z.string() })).default([]),
  resources: z
    .array(
      z.object({
        url: z.url().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        format: z.string().optional(),
        mimetype: z.string().optional(),
      })
    )
    .default([]),
})

/** PUT: same as create minus resources (update doesn't accept inline resources) */
export const updatePackageSchema = createPackageSchema.omit({ resources: true })
export type CreatePackageInput = z.infer<typeof createPackageSchema>
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>
