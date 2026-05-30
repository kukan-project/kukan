/**
 * KUKAN Resource Validators
 */

import { z } from 'zod'

/** Validate that url is a valid URL when urlType is not 'upload' */
function refineUrl(data: { url?: string | null; urlType?: string | null }, ctx: z.RefinementCtx) {
  if (data.url && data.urlType !== 'upload') {
    const result = z.url().safeParse(data.url)
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid URL',
        path: ['url'],
      })
    }
  }
}

const resourceFieldsSchema = z.object({
  packageId: z.uuid(),
  url: z.string().nullish(),
  urlType: z.enum(['upload']).nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  format: z.string().max(100).nullish(),
  mimetype: z.string().max(200).nullish(),
  size: z.number().int().positive().nullish(),
  hash: z.string().nullish(),
  resourceType: z.string().max(50).nullish(),
})

export const createResourceSchema = resourceFieldsSchema.superRefine(refineUrl)

/** Without packageId — used for nested resource creation under a package route */
export const createResourceBodySchema = resourceFieldsSchema
  .omit({ packageId: true })
  .superRefine(refineUrl)

/** PUT update: same as createResourceBodySchema (extras is system-managed, not user-editable) */
export const updateResourceSchema = createResourceBodySchema

export type CreateResourceInput = z.infer<typeof createResourceSchema>
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>

// Upload flow schemas

export const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  format: z.string().max(100).optional(),
})

export type UploadUrlInput = z.infer<typeof uploadUrlSchema>

export const uploadCompleteSchema = z.object({
  size: z.number().int().positive().optional(),
  hash: z.string().optional(),
})

export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>

export const reorderResourcesSchema = z.object({
  resourceIds: z.array(z.uuid()).min(1),
})

export type ReorderResourcesInput = z.infer<typeof reorderResourcesSchema>
