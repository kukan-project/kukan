/**
 * KUKAN Package (Dataset) Validators
 */

import { z } from 'zod'

/** package.name (URL slug) contract — single source for the schema below and
 *  for callers that generate names (e.g. AI slug suggestions) */
export const PACKAGE_NAME_PATTERN = /^[a-z0-9._-]+$/
export const PACKAGE_NAME_MIN_LENGTH = 2
export const PACKAGE_NAME_MAX_LENGTH = 100

/** The package-name contract as a predicate — one definition for the API
 *  service, scripts, and anything else that must agree with the schema. */
export function isValidPackageName(name: string): boolean {
  return (
    name.length >= PACKAGE_NAME_MIN_LENGTH &&
    name.length <= PACKAGE_NAME_MAX_LENGTH &&
    PACKAGE_NAME_PATTERN.test(name)
  )
}

export const createPackageSchema = z.object({
  name: z
    .string()
    .min(PACKAGE_NAME_MIN_LENGTH)
    .max(PACKAGE_NAME_MAX_LENGTH)
    .regex(
      PACKAGE_NAME_PATTERN,
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
  groups: z.array(z.object({ name: z.string() })).default([]),
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

/**
 * PUT: same as create minus resources. No `.default()` — the service must see
 * which keys were sent (drafts get partial updates, active packages keep
 * full-replacement semantics; ADR-039). `ownerOrg: null` clears a draft's org.
 * `name: null` on a draft regenerates the placeholder (back to "unnamed").
 */
export const updatePackageSchema = createPackageSchema
  .omit({
    resources: true,
    private: true,
    type: true,
    extras: true,
    tags: true,
    groups: true,
    name: true,
    ownerOrg: true,
  })
  .extend({
    name: createPackageSchema.shape.name.nullable().optional(),
    ownerOrg: z.uuid().nullable().optional(),
    private: z.boolean().optional(),
    type: z.string().max(100).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.object({ name: z.string() })).optional(),
    groups: z.array(z.object({ name: z.string() })).optional(),
  })

/**
 * Draft creation (POST /packages/drafts): every field is optional — name gets a
 * placeholder and ownerOrg stays unset until publish (ADR-039).
 */
export const createDraftPackageSchema = updatePackageSchema

/**
 * Restore (POST /packages/:nameOrId/restore): the body is optional. Deletion is
 * an emergency measure, so `private` brings the dataset back off the site, to be
 * fixed and then published through the ordinary visibility flag.
 */
export const restorePackageSchema = z.object({ private: z.boolean().optional() })

/** Placeholder name auto-assigned to drafts; publishing requires replacing it (ADR-039) */
export const DRAFT_NAME_PLACEHOLDER_RE = /^untitled-[0-9a-f]{8}$/

/** True when the name is still the auto-generated draft placeholder (ADR-039) */
export function isDraftPlaceholderName(name: string): boolean {
  return DRAFT_NAME_PLACEHOLDER_RE.test(name)
}

export type DraftPublishBlocker = 'name' | 'org' | 'license'

/**
 * Publish preconditions for a draft (ADR-039): a real name (not the
 * placeholder), an owner organization and a license. Single source of truth
 * for the server-side publish validation and the publish button UI.
 */
export function draftPublishBlockers(pkg: {
  name: string
  ownerOrg?: string | null
  licenseId?: string | null
}): DraftPublishBlocker[] {
  const blockers: DraftPublishBlocker[] = []
  if (isDraftPlaceholderName(pkg.name)) blockers.push('name')
  if (!pkg.ownerOrg) blockers.push('org')
  if (!pkg.licenseId) blockers.push('license')
  return blockers
}

export type CreatePackageInput = z.infer<typeof createPackageSchema>
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>
export type RestorePackageInput = z.infer<typeof restorePackageSchema>
export type CreateDraftPackageInput = z.infer<typeof createDraftPackageSchema>
