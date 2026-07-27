/**
 * KUKAN Resource Validators
 */

import { z } from 'zod'

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal'])

/** Check if a hostname is an IPv4 address in a private/reserved range */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  // Private ranges (10/8, 172.16/12, 192.168/16) are allowed for intranet deployments
  return (
    a === 127 || // loopback
    a === 0 || // 0.0.0.0/8
    (a === 169 && b === 254) // 169.254.0.0/16 (link-local, AWS IMDS)
  )
}

/** Check if a hostname is an IPv6 address in a private/reserved range */
function isPrivateIPv6(host: string): boolean {
  const addr = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (addr === '::' || addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true
  return false
}

/** Validate that url is a valid http(s) URL when urlType is not 'upload' */
function refineUrl(data: { url?: string | null; urlType?: string | null }, ctx: z.RefinementCtx) {
  if (data.url && data.urlType !== 'upload') {
    const result = z.url().safeParse(data.url)
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid URL', path: ['url'] })
      return
    }
    const parsed = new URL(data.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: 'Only http and https URLs are allowed',
        path: ['url'],
      })
      return
    }
    const hostname = parsed.hostname.toLowerCase()
    if (BLOCKED_HOSTS.has(hostname) || isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
      ctx.addIssue({
        code: 'custom',
        message: 'URL points to a private or reserved address',
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
  resourceType: z.string().max(50).nullish(),
})

// `size` and `hash` are deliberately absent: the pipeline measures the stored
// object and owns both. Version capture gates on the hash and records it
// against the bytes it copies (ADR-043), so a caller-supplied value would
// decide whether versions are ever captured.

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

export const reorderResourcesSchema = z.object({
  resourceIds: z.array(z.uuid()).min(1),
})

export type ReorderResourcesInput = z.infer<typeof reorderResourcesSchema>
