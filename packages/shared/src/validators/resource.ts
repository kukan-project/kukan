/**
 * KUKAN Resource Validators
 * CKAN-compatible resource validation schemas
 */

import { z } from 'zod'

export const createResourceSchema = z.object({
  package_id: z.string().uuid(),
  url: z.string().url().optional(), // Optional for file uploads
  name: z.string().optional(),
  description: z.string().optional(),
  format: z.string().max(100).optional(),
  mimetype: z.string().max(200).optional(),
  size: z.number().int().positive().optional(),
  hash: z.string().optional(),
  resource_type: z.string().max(50).optional(),
  extras: z.record(z.unknown()).default({}),
})

export const updateResourceSchema = createResourceSchema.omit({ package_id: true }).partial()

export type CreateResourceInput = z.infer<typeof createResourceSchema>
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>
