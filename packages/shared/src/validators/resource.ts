/**
 * KUKAN Resource Validators
 */

import { z } from 'zod'
import { checkUrlSafety } from '../url'

/** Validate that url is a valid http(s) URL when urlType is not 'upload' */
function refineUrl(data: { url?: string | null; urlType?: string | null }, ctx: z.RefinementCtx) {
  if (!data.url || data.urlType === 'upload') return

  if (!z.url().safeParse(data.url).success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid URL', path: ['url'] })
    return
  }

  // One list, two checks — the policy, and why it is shared, live in `../url`.
  const unsafe = checkUrlSafety(data.url)
  if (unsafe) {
    ctx.addIssue({
      code: 'custom',
      // Branching on `reason` rather than the message: the wording is the
      // shared module's to change, and this side has its own to keep.
      message:
        unsafe.reason === 'protocol'
          ? 'Only http and https URLs are allowed'
          : 'URL points to a private or reserved address',
      path: ['url'],
    })
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
  resourceType: z.string().max(50).nullish(),
})

// `size` and `hash` are deliberately absent: the pipeline measures the stored
// object and owns both. Version create gates on the hash and records it
// against the bytes it copies (ADR-043), so a caller-supplied value would
// decide whether versions are ever created.

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
})

export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>

/**
 * A revert states where it is putting the content, and what it saw (ADR-044 §4).
 *
 * Absolute rather than relative, because "step back one" run twice is not run
 * once: the second pass steps off what the first restored. Naming the
 * destination makes a resend land in the same place, which is the whole of
 * idempotency here — no operation ledger, nothing remembered between attempts.
 *
 * That alone would let a request delayed past a newer upload retract content
 * its caller never saw, so the generation it was looking at comes with it.
 * Idempotency and concurrency control are separate questions and get separate
 * fields: the destination answers "have I already done this", the generation
 * answers "is this still the thing I was shown".
 */
export const revertResourceSchema = z.object({
  /** Version to put the live content on, or null to leave the resource empty —
   *  which is a destination like any other, and idempotent for the same reason. */
  restoreTo: z.number().int().positive().nullable(),
  /** `live_revision` as served with the pipeline status. A UUID, and validated
   *  as one: the takeover compares it as `::uuid`, so anything else is a
   *  PostgreSQL error rather than the 400 it is. */
  ifLiveRevision: z.uuid(),
})

export type RevertResourceInput = z.infer<typeof revertResourceSchema>

/**
 * Reprocess options. Absent means an ordinary run — fetch included.
 *
 * `rebuildOnly` is the safe repair after a revert: it regenerates the
 * derivatives from the object the resource already holds, so a resource
 * reverted because its URL served the wrong thing does not have that content
 * fetched back (ADR-044 §4).
 */
export const runPipelineSchema = z.object({
  rebuildOnly: z.boolean().optional(),
})

export type RunPipelineInput = z.infer<typeof runPipelineSchema>

export const reorderResourcesSchema = z.object({
  resourceIds: z.array(z.uuid()).min(1),
})

export type ReorderResourcesInput = z.infer<typeof reorderResourcesSchema>
