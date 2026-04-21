/**
 * KUKAN Resource Validators
 * CKAN-compatible resource validation schemas
 */

import { z } from 'zod'

const resourceFieldsSchema = z.object({
  package_id: z.string().uuid(),
  url: z.string().optional(),
  url_type: z.enum(['upload']).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  format: z.string().max(100).optional(),
  mimetype: z.string().max(200).optional(),
  size: z.number().int().positive().optional(),
  hash: z.string().optional(),
  resource_type: z.string().max(50).optional(),
  extras: z.record(z.string(), z.unknown()).default({}),
})

/** Validate that url is a valid URL when url_type is not 'upload' */
function refineUrl(data: { url?: string; url_type?: string }, ctx: z.RefinementCtx) {
  if (data.url && data.url_type !== 'upload') {
    const result = z.string().url().safeParse(data.url)
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid URL',
        path: ['url'],
      })
    }
  }
}

export const createResourceSchema = resourceFieldsSchema.superRefine(refineUrl)

/** createResourceSchema without package_id — used for nested resource creation under a package route */
export const createResourceBodySchema = resourceFieldsSchema
  .omit({ package_id: true })
  .superRefine(refineUrl)

export const updateResourceSchema = resourceFieldsSchema
  .omit({ package_id: true })
  .partial()
  .superRefine(refineUrl)

export type CreateResourceInput = z.infer<typeof createResourceSchema>
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>

// Upload flow schemas

export const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(500),
  content_type: z.string().min(1).max(200),
  format: z.string().max(100).optional(),
})

export type UploadUrlInput = z.infer<typeof uploadUrlSchema>

export const uploadCompleteSchema = z.object({
  size: z.number().int().positive().optional(),
  hash: z.string().optional(),
})

export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>

export const reorderResourcesSchema = z.object({
  resource_ids: z.array(z.string().uuid()).min(1),
})

export type ReorderResourcesInput = z.infer<typeof reorderResourcesSchema>
